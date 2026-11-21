// @ts-check
// OpenClaw adapter (plan E5, docs/podpowiedzi/E5-openclaw-hermes.md). OpenClaw has no hooks we could install; its Gateway
// speaks a WebSocket protocol, and an "operator" client with the `operator.approvals` scope receives every approval
// request and may answer it. So the bridge becomes such a client (openclaw-client.js) - but ONLY while the service is
// "live" (paired, link up, away mode on). Why: the mere presence of an approvals client changes OpenClaw's behaviour
// (without one a request that nobody can answer ends at once and `askFallback` decides; with one it waits until its
// timeout), and at the desk we must change nothing (N5).
//
// Safety rules kept here (plan section 5):
//  N1  we never answer on our own: no answer from the glasses = no answer sent; OpenClaw then applies `askFallback`
//      (default: deny) or another window of the person decides;
//  N2  the ONLY decisions we ever send are `allow-once` and `deny` (see `decisionFor`);
//  N12 a `say` text is a plain message: `safeInstruction` plus a zero-width space before every `/` or `!` that follows
//      white space (OpenClaw runs `/approve <id> allow-always`, `/exec ...`, `! cmd` from chat text, also inline).
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { homeDir, writeJson, readJson } from '../store.js'
import { glassesLine, oneLine, safeInstruction } from '../text.js'
import { GatewayClient, loadIdentity, SCOPES } from './openclaw-client.js'

export const id = 'openclaw'
export const caps = { perm: 'gateway', say: 'chat' }
export const MAX_SESSIONS = 8
const ACTIVE_MS = 30 * 60 * 1000
const DEFAULT_PORT = 18789

export const dir = () => path.join(homeDir(), 'openclaw')
export const identityFile = () => path.join(dir(), 'device.json')
export const tokenFile = () => path.join(dir(), 'token.json')

/** HINTY_AGENTS_OPENCLAW = path of the `openclaw` entry (a .mjs/.js is run with node); default `openclaw` from PATH. */
const bin = () => process.env.HINTY_AGENTS_OPENCLAW || 'openclaw'
const quoteWin = (/** @type {string} */ p) => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(p) ? p : `"${p.replace(/"/g, '\\"')}"`)

/** @returns {{ found: boolean, version: string | null }} */
export function detect() {
  const b = bin()
  const js = /\.(mjs|cjs|js)$/i.test(b)
  const win = process.platform === 'win32' && !js
  const r = js
    ? spawnSync(process.execPath, [b, '--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : win
      ? spawnSync([b, '--version'].map(quoteWin).join(' '), { shell: true, encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawnSync(b, ['--version'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) return { found: false, version: null }
  const m = String(r.stdout || '').match(/(\d{4}\.\d+\.\d+)/)
  return { found: true, version: m ? m[1] : String(r.stdout || '').trim().slice(0, 40) }
}

// ------------------------------------------------------------------------------------------------
// The user's OpenClaw configuration (read only, and only at install time to pair once)
// ------------------------------------------------------------------------------------------------

export const stateDir = () => process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw')
export const configPath = () => process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir(), 'openclaw.json')

/**
 * openclaw.json is JSON5. Best effort: JSON, else without comments and trailing commas.
 * @param {string} text @returns {any}
 */
export function parseLoose(text) {
  try { return JSON.parse(text) } catch { /* json5 */ }
  let out = ''
  let inStr = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') { out += ch + (text[++i] ?? ''); continue }
      if (ch === inStr) { out += '"'; inStr = ''; continue }
      out += ch === '"' ? '\\"' : ch
      continue
    }
    if (ch === '"' || ch === "'") { inStr = ch; out += '"'; continue }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue }
    if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue }
    out += ch
  }
  out = out.replace(/,(\s*[}\]])/g, '$1').replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
  try { return JSON.parse(out) } catch { return null }
}

/**
 * Where the Gateway is and how to authenticate the first connection.
 * @param {{ tokenFile?: string }} [o]
 * @returns {{ port: number, token: string | null, needsTokenFile?: string, mode: string }}
 */
export function gatewayInfo(o = {}) {
  /** @type {any} */
  let cfg = null
  try { cfg = parseLoose(fs.readFileSync(configPath(), 'utf8')) } catch { /* no config */ }
  const gw = (cfg && cfg.gateway) || {}
  const port = Number(process.env.OPENCLAW_GATEWAY_PORT) || Number(gw.port) || DEFAULT_PORT
  const mode = (gw.auth && gw.auth.mode) || 'token'
  let token = null
  if (o.tokenFile) {
    token = fs.readFileSync(o.tokenFile, 'utf8').trim() || null
  } else if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    token = process.env.OPENCLAW_GATEWAY_TOKEN.trim()
  } else {
    const raw = mode === 'password' ? gw.auth && gw.auth.password : gw.auth && gw.auth.token
    if (typeof raw === 'string') token = raw
    else if (raw && typeof raw === 'object') {
      const envName = raw.source === 'env' ? raw.id : raw.env
      if (typeof envName === 'string' && process.env[envName]) token = process.env[envName] || null
      else return { port, token: null, needsTokenFile: raw.source || 'secret', mode }
    }
  }
  return { port, token, mode }
}

/** Plain strings that mean "OpenClaw allows by itself when nobody answers": `askFallback: full`. @returns {string[]} files */
export function askFallbackFull() {
  const found = []
  for (const f of [path.join(stateDir(), 'exec-approvals.json'), configPath()]) {
    let j
    try { j = parseLoose(fs.readFileSync(f, 'utf8')) } catch { continue }
    const walk = (/** @type {any} */ v, depth = 0) => {
      if (!v || typeof v !== 'object' || depth > 8) return false
      for (const [k, x] of Object.entries(v)) {
        if (k === 'askFallback' && x === 'full') return true
        if (walk(x, depth + 1)) return true
      }
      return false
    }
    if (walk(j)) found.push(f)
  }
  return found
}

// ------------------------------------------------------------------------------------------------
// install / uninstall / doctor
// ------------------------------------------------------------------------------------------------

/** @returns {{ installed: boolean, deviceId?: string, url?: string, scopes?: string[] }} */
export function installed() {
  const t = readJson(tokenFile())
  const idn = loadIdentity(identityFile(), { create: false })
  if (!t || !idn || typeof t.deviceToken !== 'string') return { installed: false }
  return { installed: true, deviceId: idn.deviceId, url: t.url, scopes: t.scopes }
}

/**
 * Pair once with the Gateway (the first loopback connection pairs by itself) and keep the device token.
 * The shared Gateway token is used for this one connection only and is not stored anywhere.
 * @param {{ tokenFile?: string, url?: string, WebSocketImpl?: any }} [o]
 * @returns {Promise<{ ok: boolean, steps: Array<{ step: string, ok: boolean, message: string }> }>}
 */
export async function install(o = {}) {
  const steps = []
  const info = gatewayInfo({ tokenFile: o.tokenFile })
  const url = o.url || `ws://127.0.0.1:${info.port}`
  steps.push({ step: 'gateway', ok: true, message: url })
  if (info.needsTokenFile) {
    steps.push({ step: 'token', ok: false, message: `your Gateway token is a "${info.needsTokenFile}" secret reference; give it once: npx hinty-agents install openclaw --token-file <file with the token>` })
    return { ok: false, steps }
  }
  if (!info.token) {
    steps.push({ step: 'token', ok: false, message: `no Gateway token found in ${configPath()} (or OPENCLAW_GATEWAY_TOKEN); pass --token-file <file>` })
    return { ok: false, steps }
  }
  const identity = /** @type {import('./openclaw-client.js').Identity} */ (loadIdentity(identityFile()))
  const client = new GatewayClient({ url, identity, token: info.token, scopes: SCOPES, WebSocketImpl: o.WebSocketImpl })
  try {
    const hello = await client.connect()
    const a = hello && hello.auth
    if (!a || typeof a.deviceToken !== 'string') {
      steps.push({ step: 'pairing', ok: false, message: 'the Gateway did not issue a device token' })
      return { ok: false, steps }
    }
    const scopes = Array.isArray(a.scopes) ? a.scopes : SCOPES
    writeJson(tokenFile(), { v: 1, url, deviceToken: a.deviceToken, scopes, protocol: client.protocol, issuedAtMs: a.issuedAtMs || Date.now() })
    steps.push({ step: 'pairing', ok: true, message: `device ${identity.deviceId.slice(0, 12)}... paired (protocol ${client.protocol}, OpenClaw ${hello.server && hello.server.version || '?'})` })
    steps.push({ step: 'token', ok: true, message: `device token stored in ${tokenFile()} (readable by you only; it can write to your sessions, so it never leaves this computer)` })
    if (!scopes.includes('operator.write')) steps.push({ step: 'scopes', ok: true, message: 'without operator.write the glasses cannot send instructions to OpenClaw sessions' })
  } catch (e) {
    const err = /** @type {any} */ (e)
    const hint = err.code === 'PAIRING_REQUIRED' ? ' (a remote Gateway needs `openclaw devices approve <requestId>`)'
      : err.code === 'AUTH_TOKEN_MISMATCH' ? ' (wrong Gateway token)' : ''
    steps.push({ step: 'pairing', ok: false, message: `${err.message}${hint}; is the Gateway running? (openclaw gateway)` })
    return { ok: false, steps }
  } finally {
    client.close()
  }
  for (const f of askFallbackFull()) steps.push({ step: 'WARNING', ok: true, message: `${f} has askFallback: full - OpenClaw then allows by itself when nobody answers in time. Set it to deny (OpenClaw's default) to keep "no answer = no".` })
  steps.push({ step: 'config', ok: true, message: 'nothing in your OpenClaw configuration was changed; the bridge connects only while away mode is on' })
  return { ok: true, steps }
}

/** @returns {{ ok: boolean, steps: Array<{ step: string, ok: boolean, message: string }> }} */
export function uninstall() {
  const idn = loadIdentity(identityFile(), { create: false })
  if (!fs.existsSync(dir())) return { ok: true, steps: [{ step: 'openclaw', ok: true, message: 'nothing to remove' }] }
  fs.rmSync(dir(), { recursive: true, force: true })
  const steps = [{ step: 'files', ok: true, message: `removed ${dir()} (device key and token)` }]
  if (idn) steps.push({ step: 'device', ok: true, message: `the Gateway still lists this device; to revoke it: openclaw devices remove ${idn.deviceId}` })
  return { ok: true, steps }
}

/** Extra doctor lines. @returns {Promise<Array<{ ok: boolean | null, text: string, hint?: string }>>} */
export async function doctor() {
  /** @type {Array<{ ok: boolean | null, text: string, hint?: string }>} */
  const out = []
  const inst = installed()
  if (!inst.installed) return [{ ok: null, text: 'OpenClaw: bridge not paired with the Gateway', hint: 'npx hinty-agents install openclaw' }]
  const t = /** @type {any} */ (readJson(tokenFile()))
  const idn = /** @type {import('./openclaw-client.js').Identity} */ (loadIdentity(identityFile(), { create: false }))
  const c = new GatewayClient({ url: t.url, identity: idn, deviceToken: t.deviceToken, scopes: SCOPES, connectTimeoutMs: 5000 })
  try {
    await c.connect()
    out.push({ ok: true, text: `OpenClaw Gateway reachable at ${t.url}, protocol ${c.protocol}, device token accepted` })
  } catch (e) {
    out.push({ ok: false, text: `OpenClaw Gateway: ${/** @type {Error} */ (e).message}`, hint: 'is it running (openclaw gateway)? token refused: npx hinty-agents install openclaw' })
  } finally { c.close() }
  for (const f of askFallbackFull()) out.push({ ok: null, text: `${f}: askFallback is "full" - OpenClaw allows by itself when nobody answers`, hint: 'set it to deny' })
  return out
}

// ------------------------------------------------------------------------------------------------
// Pure helpers (tested)
// ------------------------------------------------------------------------------------------------

/**
 * The ONLY decisions we ever send (N2). Anything but an explicit allow is a deny.
 * @param {unknown} d @returns {'allow-once' | 'deny'}
 */
export const decisionFor = (d) => (d === 'allow' ? 'allow-once' : 'deny')

/**
 * Text for chat.send: plain message (safeInstruction) and no `/` or `!` after white space either (inline directives).
 * @param {string} text
 */
export const disarm = (text) => safeInstruction(text).replace(/(^|\s)([/!])/gu, '$1​$2')

/** @param {unknown} content a message's `content`: a string or an array of {type:'text', text} @returns {string} */
export function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((x) => (x && typeof x === 'object' && x.type === 'text' && typeof x.text === 'string' ? x.text : '')).filter(Boolean).join('\n')
}

/** `agent:main:main` -> 'main'; `agent:publisher:telegram:123` -> 'publisher·telegram'. @param {string} key @param {string} [channel] */
export function labelFor(key, channel) {
  const parts = String(key || '').split(':')
  const agentId = parts[0] === 'agent' && parts[1] ? parts[1] : parts[0] || 'openclaw'
  const ch = channel && channel !== 'webchat' ? channel : ''
  return oneLine(ch ? `${agentId}·${ch}` : agentId, 50)
}

/** A session id for the relay: the key itself when it fits (<= 64 printable ASCII, no spaces), else `oc-` + hash. @param {string} key */
export function sidFor(key) {
  return /^[\x21-\x7e]{1,64}$/.test(key) ? key : `oc-${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 20)}`
}

// ------------------------------------------------------------------------------------------------
// The live link
// ------------------------------------------------------------------------------------------------

/**
 * @typedef {import('../service.js').Service} Service
 */

export class OpenClawLink {
  /**
   * @param {{ service: Service, log?: (m: string, f?: Record<string, any>) => void, WebSocketImpl?: any, now?: () => number,
   *   retryMs?: number, sharedToken?: () => string | null }} o
   */
  constructor(o) {
    this.service = o.service
    this.log = o.log || (() => {})
    this.WS = o.WebSocketImpl
    this.now = o.now || Date.now
    this.retryMs = o.retryMs ?? 3000
    /** @type {GatewayClient | null} */
    this.client = null
    this.running = false
    this.generation = 0
    /** @type {any} */
    this.retryTimer = null
    /** sid -> { key, at, label } */
    this.byKey = new Map()
    /** sid -> sessionKey */
    this.keys = new Map()
    /** approval id -> { rid, kind } */
    this.pending = new Map()
    this.canWrite = true
  }

  /** Connect (only if installed). Safe to call again. */
  start() {
    if (this.running) return
    if (!installed().installed) return
    this.running = true
    void this.open(++this.generation)
  }

  stop() {
    this.running = false
    this.generation++
    clearTimeout(this.retryTimer)
    this.dropPending('cancel')
    if (this.client) { const c = this.client; this.client = null; c.removeAllListeners(); c.close() }
    this.keys.clear()
    this.byKey.clear()
    this.log('oc_stop')
  }

  /** @param {string} why */
  dropPending(why) {
    for (const p of [...this.pending.values()]) this.service.endPerm(p.rid, why)
    this.pending.clear()
  }

  /** @param {number} gen */
  async open(gen) {
    const t = /** @type {any} */ (readJson(tokenFile()))
    const identity = loadIdentity(identityFile(), { create: false })
    if (!t || !identity) { this.running = false; return }
    const c = new GatewayClient({ url: t.url, identity, deviceToken: t.deviceToken, scopes: SCOPES, WebSocketImpl: this.WS })
    this.client = c
    // listeners first: events can follow the hello frame immediately
    c.on('event', (f) => { try { this.onEvent(f) } catch (e) { this.log('oc_event_error', { err: /** @type {Error} */ (e)?.name }) } })
    c.on('close', () => { if (gen === this.generation && this.client === c) this.lost() })
    try {
      const hello = await c.connect()
      if (gen !== this.generation) { c.close(); return }
      const scopes = (hello && hello.auth && hello.auth.scopes) || t.scopes || []
      this.canWrite = scopes.includes('operator.write')
      this.log('oc_up', { protocol: c.protocol })
      await this.snapshot(c)
    } catch (e) {
      if (gen !== this.generation) return
      this.log('oc_connect_failed', { err: /** @type {Error} */ (e)?.message?.slice(0, 80), code: /** @type {any} */ (e)?.code })
      this.lost()
    }
  }

  lost() {
    if (!this.running) return
    this.dropPending('cancel')
    if (this.client) { this.client.removeAllListeners(); this.client.close(); this.client = null }
    clearTimeout(this.retryTimer)
    const gen = this.generation
    this.retryTimer = setTimeout(() => { if (this.running && gen === this.generation) void this.open(gen) }, this.retryMs)
    this.retryTimer.unref?.()
  }

  /** @param {GatewayClient} c */
  async snapshot(c) {
    try { await c.request('sessions.subscribe', {}) } catch (e) { this.log('oc_subscribe_failed', { err: /** @type {Error} */ (e).message.slice(0, 60) }) }
    try {
      const r = await c.request('sessions.list', { limit: 30, includeLastMessage: true, activeMinutes: 30 })
      const rows = Array.isArray(r && r.sessions) ? r.sessions : Array.isArray(r) ? r : []
      for (const row of rows.slice(0, MAX_SESSIONS)) this.onSessionRow(row)
    } catch { /* optional */ }
    try {
      // 2026.11+: pending approvals are replayed on request (3.28 refuses: missing scope)
      const r = await c.request('exec.approval.list', {})
      const rows = Array.isArray(r && r.approvals) ? r.approvals : Array.isArray(r && r.items) ? r.items : Array.isArray(r) ? r : []
      for (const row of rows) this.onApproval('exec', row)
    } catch { /* optional */ }
  }

  /** @param {any} f */
  onEvent(f) {
    const p = f.payload || {}
    switch (f.event) {
      case 'exec.approval.requested': return this.onApproval('exec', p)
      case 'plugin.approval.requested': return this.onApproval('plugin', p)
      case 'exec.approval.resolved':
      case 'plugin.approval.resolved': return this.onResolved(p)
      case 'sessions.changed': return this.onChanged(p)
      case 'session.message': return this.onMessage(p)
      case 'agent': return this.onAgent(p)
      case 'chat': return this.onChat(p)
      default:
    }
  }

  // ---- approvals

  /** @param {'exec' | 'plugin'} kind @param {any} p */
  onApproval(kind, p) {
    const approvalId = typeof p.id === 'string' ? p.id : ''
    if (!approvalId || this.pending.has(approvalId)) return
    if (!this.service.hooksLive()) return // N1 / N5: nothing to show, nothing to answer
    const req = (p.request && typeof p.request === 'object' ? p.request : {})
    const expiresAtMs = Number(p.expiresAtMs)
    const ttlS = Math.floor(((Number.isFinite(expiresAtMs) ? expiresAtMs : this.now() + 120000) - this.now()) / 1000) - 5
    if (ttlS < 5) return // too late for a person to answer; OpenClaw's own timeout decides
    const sessionKey = typeof req.sessionKey === 'string' && req.sessionKey ? req.sessionKey : `approval:${req.agentId || 'main'}`
    const sid = sidFor(sessionKey)
    this.keys.set(sid, sessionKey)
    const cwd = typeof req.cwd === 'string' ? req.cwd : ''
    const label = labelFor(sessionKey, typeof req.turnSourceChannel === 'string' ? req.turnSourceChannel : '')
    const tool = kind === 'exec' ? 'exec' : String(req.toolName || req.pluginId || 'plugin')
    const text = kind === 'exec'
      ? `${typeof req.command === 'string' ? req.command : '(command)'}${cwd ? `\ncwd: ${cwd}` : ''}`
      : `${req.title || tool}${req.description ? `\n${req.description}` : ''}`
    const entry = { rid: '', kind }
    this.pending.set(approvalId, entry)
    const answer = this.service.requestPerm(
      { sid, cwd: '', tool, input: { id: approvalId, command: req.command ?? null, title: req.title ?? null }, agentId: null, agentType: '', cardText: text, label },
      {}, { agent: 'openclaw', ttlMs: ttlS * 1000, onCreate: (perm) => { entry.rid = perm.rid } },
    )
    this.log('oc_perm', { kind })
    answer.then((r) => {
      if (this.pending.get(approvalId) === entry) this.pending.delete(approvalId)
      if (!r || !r.d) return // N1: no decision from a person = we send nothing
      this.resolve(kind, approvalId, decisionFor(r.d))
    }, () => { this.pending.delete(approvalId) })
  }

  /**
   * The single place where a decision leaves for the Gateway (N2).
   * @param {'exec' | 'plugin'} kind @param {string} approvalId @param {'allow-once' | 'deny'} decision
   */
  resolve(kind, approvalId, decision) {
    if (decision !== 'allow-once' && decision !== 'deny') throw new Error('refused decision')
    const c = this.client
    if (!c || !c.connected) { this.log('oc_resolve_skipped'); return }
    c.request(`${kind}.approval.resolve`, { id: approvalId, decision }, 15000).then(
      () => this.log('oc_resolved', { decision }),
      (e) => this.log('oc_resolve_failed', { code: /** @type {any} */ (e).code || String(e.message).slice(0, 60) }),
    )
  }

  /** Someone else (another window) answered, or the request ended. @param {any} p */
  onResolved(p) {
    const approvalId = typeof p.id === 'string' ? p.id : ''
    const e = this.pending.get(approvalId)
    if (!e) return
    this.pending.delete(approvalId)
    this.service.endPerm(e.rid, 'local')
  }

  // ---- sessions

  /** @param {string} key @param {any} s a `session` object or list row @returns {string} */
  channelOf(key, s) {
    return (s && s.deliveryContext && s.deliveryContext.channel) || (s && s.origin && s.origin.provider) || ''
  }

  /**
   * @param {string} key @param {any} s
   * @param {{ st?: import('../sessions.js').SessState, line?: string, answer?: string }} patch
   */
  report(key, s, patch) {
    if (!key) return
    const sid = sidFor(key)
    if (!this.byKey.has(sid) && this.byKey.size >= MAX_SESSIONS) {
      // keep the eight most recently active; the oldest one without an open card is let go
      const open = new Set(this.service.perms.list().map((x) => x.sid))
      const oldest = [...this.byKey.entries()].filter(([k]) => !open.has(k)).sort((a, b) => a[1] - b[1])[0]
      if (!oldest) return
      this.byKey.delete(oldest[0])
      this.keys.delete(oldest[0])
      this.service.endSession(oldest[0])
    }
    this.byKey.set(sid, this.now())
    this.keys.set(sid, key)
    this.service.agentSession('openclaw', { sid, label: labelFor(key, this.channelOf(key, s)), say: this.canWrite, ...patch })
  }

  /** @param {any} row from sessions.list */
  onSessionRow(row) {
    const key = row && (row.key || row.sessionKey)
    if (typeof key !== 'string') return
    const age = this.now() - Number(row.updatedAt || 0)
    if (row.updatedAt && age > ACTIVE_MS) return
    const st = row.status === 'running' ? 'run' : row.status === 'failed' || row.status === 'error' ? 'err' : 'idle'
    const last = typeof row.lastMessagePreview === 'string' ? row.lastMessagePreview : ''
    this.report(key, row, { st, ...(last ? { line: glassesLine(last) } : {}) })
  }

  /** @param {any} p */
  onChanged(p) {
    const key = p.sessionKey
    if (typeof key !== 'string') return
    const s = p.session || {}
    if (p.phase === 'start') return this.report(key, s, { st: 'run' })
    if (p.phase === 'end') {
      const bad = p.status === 'failed' || p.status === 'error' || p.status === 'timeout'
      const idle = p.status === 'aborted' || p.status === 'killed'
      return this.report(key, s, { st: bad ? 'err' : idle ? 'idle' : 'done' })
    }
    if (p.status === 'running') return this.report(key, s, { st: 'run' })
    this.report(key, s, {})
  }

  /** @param {any} p */
  onAgent(p) {
    if (p.stream !== 'lifecycle' || typeof p.sessionKey !== 'string') return
    const phase = p.data && p.data.phase
    if (phase === 'start') this.report(p.sessionKey, null, { st: 'run' })
    else if (phase === 'error') this.report(p.sessionKey, null, { st: 'err' })
  }

  /** @param {any} p */
  onChat(p) {
    if (typeof p.sessionKey !== 'string') return
    if (p.state === 'aborted') this.report(p.sessionKey, null, { st: 'idle' })
    else if (p.state === 'error') this.report(p.sessionKey, null, { st: 'err' })
    else if (p.state === 'final') {
      const text = p.message && p.message.role === 'assistant' ? messageText(p.message.content) : ''
      this.report(p.sessionKey, null, { st: 'done', ...(text ? { line: glassesLine(text), answer: text } : {}) })
    }
  }

  /** @param {any} p */
  onMessage(p) {
    const m = p.message
    if (typeof p.sessionKey !== 'string' || !m || m.role !== 'assistant') return
    const text = messageText(m.content).trim()
    if (!text) return
    this.report(p.sessionKey, p.session, { line: glassesLine(text), answer: text })
  }

  // ---- commands from the glasses

  /** @param {string} sid @param {string} text already `safeInstruction`ed by the service @returns {Promise<boolean>} */
  async say(sid, text) {
    const key = this.keys.get(sid)
    const c = this.client
    if (!key || !c || !c.connected || !this.canWrite) return false
    try {
      await c.request('chat.send', { sessionKey: key, message: disarm(text), idempotencyKey: crypto.randomUUID() }, 15000)
      return true
    } catch (e) {
      this.log('oc_say_failed', { err: /** @type {Error} */ (e).message.slice(0, 60) })
      return false
    }
  }
}
