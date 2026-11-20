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
// The service is found through ~/.hinty-agents/daemon.json (port and secret). Every answer must carry the service's
// proof (HMAC of our nonce and the body), so a process squatting a stale port cannot feed instructions.

import { hmacSha256Hex, nonce } from './hmac.mjs'

/** @typedef {import('claude-code').On} On */
/** @typedef {import('claude-code').EngineInterface} Engine */
/** @typedef {{ port: number, secret: string }} Info */

const POLL_AWAY_MS = 1000
const POLL_IDLE_MS = 5000
const REPORT_WAIT_MS = 300

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

/** @param {Engine} $ @returns {Promise<Info | null>} */
async function loadInfo($) {
  const own = await $.env.get('HINTY_AGENTS_HOME')
  const base = own || `${(await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''}/.hinty-agents`
  try {
    const d = JSON.parse(String(await $.fs.read(`${base}/daemon.json`)))
    if (!Number.isInteger(d.port) || typeof d.secret !== 'string') return null
    return { port: d.port, secret: d.secret }
  } catch {
    return null
  }
}

/** @param {Engine} $ @param {Info} c @param {string} path @param {unknown} body */
async function call($, c, path, body) {
  const n = nonce()
  const res = await $.http.fetch(`http://127.0.0.1:${c.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hinty-secret': c.secret, 'x-hinty-nonce': n },
    body: JSON.stringify(body),
  })
  if (res.status !== 200) throw new Error(`http ${res.status}`)
  if (res.headers['x-hinty-proof'] !== (await hmacSha256Hex(c.secret, `${n}\n${res.text}`))) throw new Error('proof')
  return JSON.parse(res.text)
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
}

/** @param {Engine} $ @param {Info} c @param {string} sid @param {unknown} cmd */
function submit($, c, sid, cmd) {
  const o = /** @type {{ id?: unknown, text?: unknown }} */ (cmd || {})
  if (typeof o.id !== 'string' || typeof o.text !== 'string' || !o.text.trim()) return
  const ack = (/** @type {boolean} */ ok) => call($, c, '/v1/mod/ack', { sid, id: o.id, ok }).catch(() => {})
  $.ui.log(`Hinty glasses -> this session: ${o.text.slice(0, 80)}`, { to: 'debug' })
  $.prompt.submit({ text: o.text, asUser: true }).then(() => ack(true), () => ack(false))
}

/** @param {Engine} $ */
async function tick($) {
  if (busy || ended || Date.now() < pauseUntil) return
  busy = true
  try {
    const c = info || (info = await loadInfo($))
    if (!c) { away = false; pauseUntil = Date.now() + 10000; return }
    const sid = await $.session.id()
    const r = await call($, c, '/v1/mod/poll', { sid, cwd, interactive, away, wait: 0 })
    away = r.away === true
    pauseUntil = Date.now() + (away ? POLL_AWAY_MS : POLL_IDLE_MS) - 50
    for (const cmd of Array.isArray(r.cmds) ? r.cmds : []) submit($, c, sid, cmd)
  } catch {
    info = null
    away = false
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
