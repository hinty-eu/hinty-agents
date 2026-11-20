// @ts-check
// The service's core: sessions, pending permissions, away mode and the commands queued for sessions.
// No sockets or HTTP here: the daemon feeds it hook/mod requests and relay events, and gives it a `relay` with
// `connected` and `emit(ev, payload)`. Every outgoing event passes `send()`, the single gate for N5.
import os from 'node:os'
import { AwayMode } from './away.js'
import { PermTable } from './perms.js'
import { SessionTable, SID_RE } from './sessions.js'
import { glassesLine, oneLine, permText, relayText } from './text.js'
import { Utterances } from './stt/utterance.js'

export const PROTOCOL_V = 1
/** Hook `timeout` in hooks.json is 900 s; the request (and the relay's card) expires earlier so the hook can end cleanly. */
export const PERM_TTL_MS = 840 * 1000
export const POLL_HOLD_MS = 20 * 1000
const SESS_REFRESH_MS = 10 * 60 * 1000
/** after session.end, ignore that session's late polls and events for this long */
const ENDED_MS = 15 * 1000

/** @typedef {{ d?: 'allow' | 'deny' }} HookAnswer */
/** @typedef {{ onAbort?: (fn: () => void) => void }} Ctl */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
/** @param {Record<string, unknown>} o @param {string} keys */
const exactKeys = (o, keys) => Object.keys(o).sort().join(',') === keys

export class Service {
  /**
   * @param {{ relay: { connected: boolean, emit: (ev: string, payload?: unknown) => void },
   *   paired?: boolean, log?: (m: string, f?: Record<string, any>) => void, now?: () => number,
   *   permTtlMs?: number, pollHoldMs?: number, sessDebounceMs?: number, host?: string,
   *   onUnpaired?: (why: string) => void, awayMaxMs?: number,
   *   voice?: { engine: import('./stt/utterance.js').Engine, ready: () => boolean } }} o
   */
  constructor(o) {
    this.relay = o.relay
    this.paired = o.paired !== false
    this.log = o.log || (() => {})
    this.now = o.now || Date.now
    this.permTtlMs = o.permTtlMs ?? PERM_TTL_MS
    this.pollHoldMs = o.pollHoldMs ?? POLL_HOLD_MS
    this.sessDebounceMs = o.sessDebounceMs ?? 250
    this.host = oneLine(o.host ?? os.hostname(), 60)
    this.onUnpaired = o.onUnpaired || (() => {})
    this.away = new AwayMode({ now: this.now, maxMs: o.awayMaxMs, onChange: (on, why) => this.onAwayChange(on, why) })
    this.voiceReady = o.voice ? o.voice.ready : () => false
    // E3: spoken instructions. Without a voice engine every utterance is answered `no_stt`.
    this.voice = new Utterances({
      engine: o.voice ? o.voice.engine : { createVad() { throw new Error('no_stt') }, recognize: () => Promise.reject(new Error('no_stt')), load: () => Promise.reject(new Error('no_stt')) },
      send: (ev, payload) => this.send(ev, payload),
      awayOn: () => this.away.isOn(),
      hasSession: (sid) => !!this.sessions.get(sid),
      ready: () => this.voiceReady(),
      log: this.log, now: this.now,
    })
    this.perms = new PermTable({ now: this.now })
    this.sessions = new SessionTable({ now: this.now })
    /** @type {Map<string, { resolve: (a: HookAnswer) => void, timer: any }>} */
    this.waiters = new Map()
    /** @type {Map<string, Array<{ id: string, text: string }>>} */
    this.cmds = new Map()
    /** @type {Map<string, Set<() => void>>} */
    this.pollers = new Map()
    /** @type {Set<string>} */
    this.dirty = new Set()
    /** sessions that just ended: a poll or event still in flight must not bring them back */
    /** @type {Map<string, number>} */
    this.ended = new Map()
    /** @type {any} */
    this.flushTimer = null
    this.cmdSeq = 0
    this.lastRefresh = 0
    this.relayInfo = { lastError: /** @type {string | null} */ (null), readyAt: 0 }
    this.startedAt = this.now()
  }

  // ------------------------------------------------------------------------------------------------
  // Outgoing (N5): with away mode off only `hello`, the `away` report and `unpair` go out; they carry no agent data.
  // ------------------------------------------------------------------------------------------------

  /** @param {string} ev @param {unknown} [payload] */
  send(ev, payload) {
    if (!this.relay.connected) return false
    // An `stt` that is only an error (no text) says nothing about the agents, so the screen may learn `away_off` (E3).
    const sttErr = ev === 'stt' && !!payload && typeof payload === 'object' && /** @type {any} */ (payload).text === '' && typeof /** @type {any} */ (payload).err === 'string'
    const meta = ev === 'hello' || ev === 'away' || ev === 'unpair' || sttErr
    if (!meta && !this.away.isOn()) return false
    this.relay.emit(ev, payload)
    return true
  }

  hello() {
    this.send('hello', { v: PROTOCOL_V, host: this.host, agents: ['claude'], away: this.away.isOn(), ...(this.voiceReady() ? { stt: true } : {}) })
  }

  /** @param {import('./sessions.js').Session} s */
  sessPayload(s) {
    return { id: s.sid, agent: s.agent, label: s.label, st: s.st, line: s.line, at: s.at }
  }

  /** @param {string} sid */
  queueSess(sid) {
    if (!this.away.on) return
    this.dirty.add(sid)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushSess(), this.sessDebounceMs)
    }
  }

  flushSess() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    const sids = [...this.dirty]
    this.dirty.clear()
    if (!this.away.isOn()) return
    for (const sid of sids) {
      const s = this.sessions.get(sid)
      if (s) this.send('sess', this.sessPayload(s))
    }
  }

  /** Everything the viewer needs after (re)connecting or when away mode turns on. */
  sendAll() {
    if (!this.away.isOn()) return
    this.dirty.clear()
    for (const s of this.sessions.list()) this.send('sess', this.sessPayload(s))
    for (const p of this.perms.list()) {
      const left = Math.floor((p.expiresAt - this.now()) / 1000)
      if (left >= 1) this.send('perm', this.permPayload(p, left))
    }
    this.lastRefresh = this.now()
  }

  /** @param {import('./perms.js').Perm & { shownTool?: string }} p @param {number} exp */
  permPayload(p, exp) {
    return { rid: p.rid, sid: p.sid, tool: p.shownTool || oneLine(p.tool, 80), text: p.text, hash: p.hash, exp }
  }

  // ------------------------------------------------------------------------------------------------
  // Hooks (from the Claude Code plugin, through the local HTTP port)
  // ------------------------------------------------------------------------------------------------

  /**
   * PermissionRequest. Resolves `{}` (no decision: the agent asks in the terminal) unless the person decides from the
   * glasses or panel in time (N1, D8). Only `{d:'allow'}` or `{d:'deny'}` otherwise (N2).
   * @param {unknown} input @param {Ctl} [ctl] @returns {Promise<HookAnswer>}
   */
  async hookPermission(input, ctl = {}) {
    if (!this.paired || !this.relay.connected || !this.away.isOn()) return {}
    if (!isObj(input)) return {}
    const sid = input.session_id
    if (typeof sid !== 'string' || !SID_RE.test(sid)) return {}
    const tool = typeof input.tool_name === 'string' && input.tool_name ? input.tool_name : 'tool'
    const agentId = typeof input.agent_id === 'string' && input.agent_id ? input.agent_id : null
    const agentType = typeof input.agent_type === 'string' ? input.agent_type : ''
    this.sessions.touch({ sid, cwd: typeof input.cwd === 'string' ? input.cwd : '' })
    const perm = /** @type {import('./perms.js').Perm & { shownTool?: string }} */ (this.perms.create({
      sid, agentId, tool, input: input.tool_input, text: permText(tool, input.tool_input), ttlMs: this.permTtlMs,
    }))
    perm.shownTool = oneLine(agentType ? `${tool} › ${agentType}` : tool, 80)
    const answer = new Promise((resolve) => {
      const timer = setTimeout(() => this.endPerm(perm.rid, 'timeout'), this.permTtlMs)
      this.waiters.set(perm.rid, { resolve, timer })
    })
    ctl.onAbort?.(() => this.endPerm(perm.rid, 'cancel'))
    // the session's state goes first, so the card has a label
    this.sessions.set(sid, { st: 'perm' })
    this.dirty.delete(sid)
    const s = this.sessions.get(sid)
    if (s) this.send('sess', this.sessPayload(s))
    this.send('perm', this.permPayload(perm, Math.floor(this.permTtlMs / 1000)))
    this.log('perm_in', { rid: perm.rid, t: perm.createdAt })
    return /** @type {Promise<HookAnswer>} */ (answer)
  }

  /**
   * End a waiting request without a decision (N1): the hook gets an empty result.
   * @param {string} rid @param {string} why
   */
  endPerm(rid, why) {
    const p = this.perms.finish(rid)
    if (!p) return
    if (why !== 'refused' && why !== 'link_lost' && why !== 'away_off') this.send('perm_end', { rid, why })
    this.release(p, why)
  }

  /**
   * @param {import('./perms.js').Perm} p @param {string} why @param {'allow' | 'deny'} [d]
   */
  release(p, why, d) {
    const w = this.waiters.get(p.rid)
    if (w) {
      clearTimeout(w.timer)
      this.waiters.delete(p.rid)
      w.resolve(d ? { d } : {})
    }
    this.log('perm_end', { rid: p.rid, why, d })
    const others = this.perms.list((x) => x.sid === p.sid).length
    if (!others && this.sessions.get(p.sid)) {
      const st = why === 'timeout' || why === 'refused' ? 'ask' : why === 'cancel' ? 'idle' : 'run'
      if (this.sessions.set(p.sid, { st })) this.queueSess(p.sid)
    }
  }

  /** @param {string} why */
  releaseAll(why) {
    for (const p of this.perms.list()) {
      this.perms.finish(p.rid)
      this.release(p, why)
    }
  }

  /**
   * SessionStart: register the session locally (label from the folder). Nothing leaves while away mode is off.
   * @param {unknown} input
   */
  hookSessionStart(input) {
    if (!isObj(input)) return { ok: false }
    const sid = input.session_id
    if (typeof sid !== 'string' || !SID_RE.test(sid)) return { ok: false }
    this.ended.delete(sid)
    const { s, isNew } = this.sessions.touch({ sid, cwd: typeof input.cwd === 'string' ? input.cwd : '' })
    if (input.source === 'clear' || input.source === 'startup' || isNew) {
      if (this.sessions.set(sid, { st: 'idle' }) || isNew) this.queueSess(sid)
    }
    return { ok: true, label: s.label }
  }

  // ------------------------------------------------------------------------------------------------
  // Mod (runs inside Claude Code): short polls for commands (a hold of up to 20 s is supported), session events
  // ------------------------------------------------------------------------------------------------

  /**
   * @param {unknown} body {sid, cwd?, interactive?, away?, wait?} @param {Ctl} [ctl]
   * @returns {Promise<{ away: boolean, cmds: Array<{ id: string, text: string }> }>}
   */
  async modPoll(body, ctl = {}) {
    if (!isObj(body) || typeof body.sid !== 'string' || !SID_RE.test(body.sid)) return { away: false, cmds: [] }
    const sid = body.sid
    if (this.isEnded(sid)) return { away: this.away.isOn(), cmds: [] }
    const { isNew } = this.sessions.touch({
      sid, cwd: typeof body.cwd === 'string' ? body.cwd : '', fromMod: true,
      interactive: typeof body.interactive === 'boolean' ? body.interactive : undefined,
    })
    if (isNew) this.queueSess(sid)
    const take = () => {
      const q = this.cmds.get(sid) || []
      this.cmds.delete(sid)
      return { away: this.away.isOn(), cmds: q }
    }
    if ((this.cmds.get(sid) || []).length) return take()
    // the mod's idea of away mode is wrong (first poll, or it changed meanwhile): answer at once
    if (typeof body.away === 'boolean' && body.away !== this.away.isOn()) return take()
    const wait = typeof body.wait === 'number' ? Math.max(0, Math.min(body.wait, this.pollHoldMs)) : this.pollHoldMs
    if (!wait) return take()
    await new Promise((resolve) => {
      const set = this.pollers.get(sid) || new Set()
      const done = () => { clearTimeout(timer); set.delete(done); if (!set.size) this.pollers.delete(sid); resolve(undefined) }
      const timer = setTimeout(done, wait)
      set.add(done)
      this.pollers.set(sid, set)
      ctl.onAbort?.(done)
    })
    return take()
  }

  /** @param {string} sid */
  isEnded(sid) {
    const at = this.ended.get(sid)
    return at !== undefined && this.now() - at < ENDED_MS
  }

  /** @param {string} [sid] wake one session's poll, or all */
  wake(sid) {
    const sets = sid ? [this.pollers.get(sid)] : [...this.pollers.values()]
    for (const set of sets) for (const fn of [...(set || [])]) fn()
  }

  /**
   * Events the mod reports while away mode is on: turn.start, tool.check, turn.complete, session.end.
   * @param {unknown} body
   */
  modEvent(body) {
    if (!isObj(body) || typeof body.sid !== 'string' || !SID_RE.test(body.sid) || typeof body.ev !== 'string') {
      return { ok: false, away: this.away.isOn() }
    }
    const sid = body.sid
    const ev = body.ev
    const now = this.now()
    const at = typeof body.at === 'number' && Number.isFinite(body.at) ? Math.min(body.at, now) : now
    const agentKey = typeof body.agentId === 'string' ? body.agentId : ''

    if (ev === 'session.end') {
      this.ended.set(sid, now)
      for (const p of this.perms.list((x) => x.sid === sid)) this.endPerm(p.rid, 'session_end')
      const s = this.sessions.remove(sid)
      this.cmds.delete(sid)
      this.dirty.delete(sid)
      if (s) this.send('sess', { ...this.sessPayload(s), st: 'end' })
      return { ok: true, away: this.away.isOn() }
    }

    if (this.isEnded(sid)) return { ok: true, away: this.away.isOn() }
    this.sessions.touch({ sid, cwd: typeof body.cwd === 'string' ? body.cwd : '', fromMod: true })

    // A permission prompt answered at the keyboard does not end the waiting hook (E0): later activity of the same
    // session and (sub)agent means it was answered, so the card is closed and the hook ends empty.
    const local = ev === 'turn.complete' && !agentKey
      ? this.perms.list((p) => p.sid === sid && p.agentKey === '' && at > p.createdAt)
      : this.perms.localActivity({ sid, agentKey, at })
    for (const p of local) this.endPerm(p.rid, 'local')

    if (!this.away.isOn()) return { ok: true, away: false }

    let changed = false
    if (ev === 'turn.start' && !agentKey) {
      changed = this.sessions.set(sid, { st: 'run' })
    } else if (ev === 'tool.check') {
      if (!this.perms.list((p) => p.sid === sid).length) {
        changed = this.sessions.set(sid, { st: body.tool === 'AskUserQuestion' ? 'ask' : 'run' })
      }
    } else if (ev === 'turn.complete' && !agentKey) {
      const s = this.sessions.get(sid)
      const answer = typeof body.answer === 'string' ? body.answer : ''
      if (s) s.answer = relayText(answer)
      const reason = body.reason
      const st = reason === 'answer' ? 'done' : reason === 'aborted' ? 'idle' : 'err'
      changed = this.sessions.set(sid, { st, line: answer ? glassesLine(answer) : '' })
    }
    if (changed) this.queueSess(sid)
    return { ok: true, away: true }
  }

  /** @param {unknown} body {sid, id, ok} */
  modAck(body) {
    if (!isObj(body) || typeof body.sid !== 'string' || typeof body.id !== 'string') return { ok: false }
    this.log('say_done', { id: body.id, ok: body.ok === true })
    return { ok: true }
  }

  // ------------------------------------------------------------------------------------------------
  // Relay (server) events
  // ------------------------------------------------------------------------------------------------

  /** @param {string} ev @param {unknown} payload */
  onRelay(ev, payload) {
    switch (ev) {
      case 'ready':
        this.relayInfo.readyAt = this.now()
        this.relayInfo.lastError = null
        this.hello()
        this.sendAll()
        return
      case 'disconnect':
        // N1: link lost = the relay forgets our requests; the hooks end empty at once
        this.releaseAll('link_lost')
        this.voice.dropActive()
        return
      case 'audio_start': this.voice.onStart(payload); return
      case 'audio': this.voice.onAudio(payload); return
      case 'audio_end': this.voice.onEnd(payload); return
      case 'decide': {
        const r = this.perms.decide(payload, { away: this.away.isOn() })
        if (!r.ok) {
          this.log('decide_refused', { reason: r.reason, rid: isObj(payload) && typeof payload.rid === 'string' ? payload.rid.slice(0, 32) : undefined })
          return
        }
        this.release(r.perm, 'decided', r.d)
        return
      }
      case 'perm_refused': {
        if (!isObj(payload) || typeof payload.rid !== 'string') return
        this.endPerm(payload.rid, 'refused')
        return
      }
      case 'say': {
        if (!isObj(payload) || !exactKeys(payload, 'sid,text')) return
        const { sid, text } = payload
        if (typeof sid !== 'string' || typeof text !== 'string' || !text.trim() || text.length > 8000) return
        if (!this.away.isOn() || !this.sessions.get(sid)) {
          this.log('say_refused', { reason: this.away.on ? 'no_session' : 'away_off' })
          return
        }
        const q = this.cmds.get(sid) || []
        if (q.length >= 10) q.shift()
        const id = String(++this.cmdSeq)
        q.push({ id, text })
        this.cmds.set(sid, q)
        this.log('say_in', { id })
        this.wake(sid)
        return
      }
      case 'away': {
        if (!isObj(payload) || !exactKeys(payload, 'on') || typeof payload.on !== 'boolean') return
        this.setAway(payload.on, 'remote')
        return
      }
      case 'want': {
        if (!isObj(payload) || typeof payload.what !== 'string') return
        if (!Object.keys(payload).every((k) => k === 'sid' || k === 'what')) return
        if (!this.away.isOn()) return
        if (payload.what === 'state') { this.hello(); this.sendAll(); return }
        if (payload.what === 'full') {
          const list = typeof payload.sid === 'string' ? [this.sessions.get(payload.sid)] : this.sessions.list()
          for (const s of list) if (s && s.answer) this.send('msg', { sid: s.sid, text: s.answer })
        }
        return
      }
      case 'unpaired':
        this.paired = false
        this.releaseAll('unpaired')
        this.onUnpaired('revoked')
        return
      case 'invalid_token':
        this.paired = false
        this.releaseAll('unpaired')
        this.onUnpaired('invalid_token')
        return
      case 'denied':
      case 'connect_error':
        this.relayInfo.lastError = isObj(payload) && typeof payload.reason === 'string' ? payload.reason : String(ev)
        return
      default:
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Away mode
  // ------------------------------------------------------------------------------------------------

  /** @param {boolean} on @param {string} why */
  setAway(on, why) {
    const changed = this.away.set(on, why)
    if (!changed && on) this.send('away', { on: true }) // renewed: report again (12 h from now)
    return { away: this.away.on, until: this.away.until }
  }

  /** @param {boolean} on @param {string} why */
  onAwayChange(on, why) {
    this.log('away', { on, why })
    if (on) {
      this.send('away', { on: true })
      this.sendAll()
    } else {
      // N5/D11: release every waiting hook, drop queued commands and whatever came from the agents' output
      this.releaseAll('away_off')
      this.voice.abortAll('away_off')
      this.cmds.clear()
      this.dirty.clear()
      this.sessions.forgetContent()
      this.send('away', { on: false })
    }
    this.wake()
  }

  // ------------------------------------------------------------------------------------------------
  // Housekeeping and status
  // ------------------------------------------------------------------------------------------------

  tick() {
    for (const p of this.perms.expired()) this.endPerm(p.rid, 'timeout')
    for (const s of this.sessions.sweep()) {
      this.cmds.delete(s.sid)
      this.send('sess', { ...this.sessPayload(s), st: 'end' })
    }
    this.perms.sweepSpent()
    for (const [sid, at] of this.ended) if (this.now() - at >= ENDED_MS) this.ended.delete(sid)
    if (this.away.isOn() && this.now() - this.lastRefresh > SESS_REFRESH_MS) this.sendAll()
  }

  status() {
    return {
      v: PROTOCOL_V,
      pid: process.pid,
      startedAt: this.startedAt,
      paired: this.paired,
      relay: { connected: this.relay.connected, lastError: this.relayInfo.lastError, readyAt: this.relayInfo.readyAt },
      away: { on: this.away.isOn(), until: this.away.until },
      sessions: this.sessions.list().map((s) => ({
        sid: s.sid.slice(0, 8), label: s.label, agent: s.agent, st: s.st, mod: !!s.modSeenAt,
        modAgoMs: s.modSeenAt ? this.now() - s.modSeenAt : null, interactive: s.interactive,
      })),
      perms: this.perms.list().length,
      voice: { ready: this.voiceReady(), busy: !!this.voice.active },
    }
  }

  /** The voice was installed or removed while running: tell the relay again (the contract allows a repeated `hello`). */
  voiceChanged() {
    this.hello()
    return { ok: true, stt: this.voiceReady() }
  }

  stop() {
    this.voice.dropActive()
    this.releaseAll('stopping')
    this.wake()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.away.timer) this.away.clearTimer(this.away.timer)
  }
}
