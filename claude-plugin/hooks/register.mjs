// @ts-check
// Hinty Agents mod for Claude Code (runs inside the Claude Code process, no Node APIs: only `$`).
//
// 1. Asks the local Hinty Agents service for instructions sent from the glasses or the Hinty panel and submits each one
//    as the user's own message: `$.prompt.submit({ text, asUser: true })` waits until the session is idle and starts
//    a turn (plan §4.2, E0 T10). Short requests, never held open: every second while away mode is on, every 5 s while
//    it is off. (A held request delays the end of a `claude -p` run until it returns: measured 18 s with a 20 s hold.)
// 2. While away mode is on (the service says so in every poll answer), reports the session's state without starting
//    a process per event: turn start, each tool call's permission check, and the turn's end with the final answer
//    (the service keeps the `👓` line). While away mode is off it reports nothing.
//
// The session is identified by `$.session.id()`: the transcript's name, the same id the hooks get as `session_id`.
// It is read again for every report, because `/clear` moves the process to a new session without a `session.start`.
//
// The service is found through ~/.hinty-agents/daemon.json (port and key; $HINTY_AGENTS_HOME only when absolute).
// Local protocol v2 (src/localauth.js): every request is signed with the key (the key never travels) and every answer
// must carry the service's signature over our nonce, the status and the body, so a process squatting a stale port
// can neither read the key nor feed instructions. Another protocol version in daemon.json = the mod stays quiet.
//
// While away mode is on the status line shows it (and that it was switched on remotely, from the panel or glasses),
// and a remote switch-on raises a toast once, so the person at this computer always sees it.

import { hmacSha256Hex, nonce, sha256Hex } from './hmac.mjs'

/** @typedef {import('claude-code').On} On */
/** @typedef {import('claude-code').EngineInterface} Engine */
/** @typedef {{ port: number, key: string, pid: number }} Info */

const POLL_AWAY_MS = 1000
const POLL_IDLE_MS = 5000
const REPORT_WAIT_MS = 300
const PV = 2

/** @type {Info | null} */
let info = null
let away = false
let busy = false
let ended = false
let pauseUntil = 0
let cwd = ''
let interactive = false
/** @type {{ cancel: () => void } | null} */
let timer = null
/** what the status line says now ('' = nothing), and the remote switch-on already shown as a toast */
let shown = ''
let toastedRemote = 0

/** @param {unknown} p */
const isAbs = (p) => typeof p === 'string' && (/^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/]/.test(p) || p.startsWith('/'))

/** @param {Engine} $ @returns {Promise<Info | null>} */
async function loadInfo($) {
  const own = await $.env.get('HINTY_AGENTS_HOME')
  const base = own && isAbs(own) ? own : `${(await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''}/.hinty-agents`
  try {
    const d = JSON.parse(String(await $.fs.read(`${base}/daemon.json`)))
    if (d.pv !== PV || !Number.isInteger(d.port) || typeof d.key !== 'string' || d.key.length < 32 || !Number.isInteger(d.pid)) return null
    return { port: d.port, key: d.key, pid: d.pid }
  } catch {
    return null
  }
}

/**
 * One signed request; the answer counts only with the service's signature. @param {Engine} $ @param {Info} c
 * @param {'GET' | 'POST'} method @param {string} path @param {string} text body ('' for GET) @param {number} [ms] limit
 */
async function signed($, c, method, path, text, ms) {
  const n = nonce()
  const ts = String(Date.now())
  const auth = await hmacSha256Hex(c.key, `hinty-req\n${PV}\n${ts}\n${n}\n${method}\n${path}\n${await sha256Hex(text)}`)
  const req = $.http.fetch(`http://127.0.0.1:${c.port}${path}`, {
    method,
    headers: { ...(text ? { 'content-type': 'application/json' } : {}), 'x-hinty-pv': String(PV), 'x-hinty-ts': ts, 'x-hinty-nonce': n, 'x-hinty-auth': auth },
    ...(text ? { body: text } : {}),
  })
  const res = /** @type {any} */ (await (ms ? Promise.race([req, $.clock.sleep(ms).then(() => { throw new Error('timeout') })]) : req))
  if (res.status !== 200) throw new Error(`http ${res.status}`)
  const want = await hmacSha256Hex(c.key, `hinty-res\n${PV}\n${n}\n200\n${await sha256Hex(res.text)}`)
  if (res.headers['x-hinty-sig'] !== want) throw new Error('signature')
  return JSON.parse(res.text)
}

/**
 * A request with content. Security review 2, Z6: the service proves itself first with a signed /v1/ping carrying the
 * pid from daemon.json; a process that took the port of a dead service gets nothing (not the session id, not an answer).
 * @param {Engine} $ @param {Info} c @param {string} path @param {unknown} body
 */
async function call($, c, path, body) {
  const p = await signed($, c, 'GET', '/v1/ping', '', 1000)
  if (!p || p.ok !== true || p.pid !== c.pid) throw new Error('not our service')
  return signed($, c, 'POST', path, JSON.stringify(body))
}

/**
 * Second layer of N12 (the service does it first): every line that starts with / ! # @ $ gets a zero-width space in
 * front; control characters other than tab and newline, and direction marks, go. Idempotent.
 * @param {string} text
 */
export function plain(text) {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .split('\n').map((l) => { const b = l.replace(/^\s+/u, ''); return b && '/!#@$'.includes(b[0]) ? `\u200b${b}` : l }).join('\n')
}

/** Status line + a toast for a remote switch-on. @param {Engine} $ @param {{ away?: unknown, remote?: unknown }} r */
function showAway($, r) {
  const remote = r.away === true && typeof r.remote === 'number' && r.remote > 0 ? r.remote : 0
  const text = r.away === true ? `\u{1F453} Hinty away mode ON${remote ? ' (switched on remotely)' : ''}` : ''
  try {
    if (text !== shown) { shown = text; $.ui.status(text || undefined) }
    if (remote && remote !== toastedRemote) {
      toastedRemote = remote
      const at = new Date(remote)
      const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
      $.ui.toast(`Hinty: away mode was switched on remotely at ${hhmm}. At the desk: npx hinty-agents away off`, { timeoutMs: 15000 })
    }
  } catch { /* an older Claude Code without these: nothing to show */ }
}

/** Wait for `p` at most `ms` (a slow service never holds Claude Code up). @param {Engine} $ @param {Promise<unknown>} p @param {number} ms */
function bounded($, p, ms) {
  return Promise.race([p.catch(() => {}), $.clock.sleep(ms).catch(() => {})])
}

/** @param {Engine} $ @param {Record<string, unknown>} body */
async function report($, body) {
  const c = info
  if (!away || !c) return
  try {
    const sid = await $.session.id()
    const r = await call($, c, '/v1/mod/event', { sid, cwd, ...body })
    away = r.away === true
  } catch {
    away = false
  }
  if (!away) showAway($, { away })
}

/** @param {Engine} $ @param {Info} c @param {string} sid @param {unknown} cmd */
function submit($, c, sid, cmd) {
  const o = /** @type {{ id?: unknown, text?: unknown }} */ (cmd || {})
  if (typeof o.id !== 'string' || typeof o.text !== 'string' || !o.text.trim()) return
  const text = plain(o.text)
  const ack = (/** @type {boolean} */ ok) => call($, c, '/v1/mod/ack', { sid, id: o.id, ok }).catch(() => {})
  $.ui.log(`Hinty glasses -> this session: instruction ${o.id} (${text.length} characters)`, { to: 'debug' })
  $.prompt.submit({ text, asUser: true }).then(() => ack(true), () => ack(false))
}

/** @param {Engine} $ */
async function tick($) {
  if (busy || ended || Date.now() < pauseUntil) return
  busy = true
  try {
    const c = info || (info = await loadInfo($))
    if (!c) { away = false; showAway($, { away }); pauseUntil = Date.now() + 10000; return }
    const sid = await $.session.id()
    const r = await call($, c, '/v1/mod/poll', { sid, cwd, interactive, away, wait: 0 })
    away = r.away === true
    showAway($, r)
    pauseUntil = Date.now() + (away ? POLL_AWAY_MS : POLL_IDLE_MS) - 50
    for (const cmd of Array.isArray(r.cmds) ? r.cmds : []) submit($, c, sid, cmd)
  } catch {
    info = null
    away = false
    showAway($, { away })
    pauseUntil = Date.now() + 5000
  } finally {
    busy = false
  }
}

/** @param {On} on */
export function register(on) {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    interactive = e.isInteractive
    ended = false
    pauseUntil = 0
    if (timer) timer.cancel()
    timer = $.clock.every(POLL_AWAY_MS, () => { void tick($) })
    // a first poll at once: registers the session and learns the away mode before the first turn
    await bounded($, tick($), 300)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ended = true
    if (timer) { timer.cancel(); timer = null }
    const c = info
    if (c) await bounded($, call($, c, '/v1/mod/event', { sid: e.sessionId, ev: 'session.end', at: Date.now() }), 400)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (away && e.agentId === undefined) await bounded($, report($, { ev: 'turn.start', at: Date.now() }), REPORT_WAIT_MS)
    return next(e)
  })

  // Every tool call's permission check (not `tool.call`: hooking that turns off moving a running command to the
  // background and live output for the tool). Only observed: the verdict passes through unchanged.
  on('tool.check', async ($, e, next) => {
    const at = Date.now()
    const verdict = await next(e)
    if (away && e.tool_use_id !== undefined) {
      const body = { ev: 'tool.check', at, tool: e.tool, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) }
      await bounded($, report($, body), REPORT_WAIT_MS)
    }
    return verdict
  })

  on('turn.complete', async ($, e, next) => {
    const at = Date.now()
    const result = await next(e)
    if (away) {
      const body = e.agentId !== undefined
        ? { ev: 'turn.complete', at, reason: e.reason, agentId: e.agentId }
        : { ev: 'turn.complete', at, reason: e.reason, answer: String(e.answer || '').slice(0, 20000) }
      await bounded($, report($, body), 500)
    }
    return result
  })
}
