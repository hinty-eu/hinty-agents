'use strict'
// Hinty Agents hook for Codex CLI. Registered in $CODEX_HOME/hooks.json for these events (argv[2] = the event):
//   PermissionRequest  asks the local service and waits; prints an allow/deny decision only when the person decided on
//                      their glasses or in the Hinty panel. Every other case prints nothing and exits 0, so Codex asks
//                      in the terminal as usual (N1).
//   Stop               reports the end of a turn; while away mode is on it holds up to ~9 minutes for a follow-up
//                      instruction from the glasses and hands it over as {"decision":"block","reason":...}.
//   SessionStart       registers the session and adds the one-line glasses instruction (the glasses line).
//   UserPromptSubmit, PostToolUse, SessionEnd  short status reports; never print anything.
// Prints nothing but the fixed JSON below.

const { CONTEXT, home, readJson, daemonInfo, send, autostart, readStdin } = require('./common.cjs')

const EVENT = process.argv[2] || ''
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
const DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Hinty glasses"}}}'
const ROUTES = {
  PermissionRequest: '/v1/hook/codex/permission',
  Stop: '/v1/hook/codex/stop',
  SessionStart: '/v1/hook/codex/session-start',
  UserPromptSubmit: '/v1/hook/codex/prompt',
  PostToolUse: '/v1/hook/codex/tool',
  SessionEnd: '/v1/hook/codex/session-end',
}
// hooks.json gives these hooks 600 s; never outlive that (the service gives up earlier: 570 s permission, 540 s Stop)
const HARD_EXIT_MS = 595000

function hold(d, raw, print) {
  setTimeout(() => process.exit(0), HARD_EXIT_MS).unref()
  // the service proves itself first (signed ping, 1.5 s); only then the content goes out and the hook may wait
  send(d, 'POST', ROUTES[EVENT], raw, 1500, 0, print)
}

function sessionStart(raw, dir) {
  const cfg = readJson(require('path').join(dir, 'config.json'))
  if (!cfg || typeof cfg.bridgeToken !== 'string' || cfg.bridgeToken.length < 16) return
  const finish = () => process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONTEXT },
  }))
  let cwd = ''
  try { cwd = String(JSON.parse(raw).cwd || '') } catch (e) { /* no cwd */ }
  const d = daemonInfo(dir)
  if (!d) { autostart(cfg, cwd); finish(); return }
  send(d, 'POST', ROUTES.SessionStart, raw, 700, 1500, (ans) => {
    if (!ans) autostart(cfg, cwd)
    finish()
  })
}

// the service sends `codex queue` to the session's own CODEX_HOME, which only the hook (inside Codex) knows
function withHome(raw) {
  const h = process.env.CODEX_HOME
  if (!h) return raw
  try {
    const o = JSON.parse(raw)
    if (o && typeof o === 'object' && !Array.isArray(o)) { o.hinty_codex_home = h; return JSON.stringify(o) }
  } catch (e) { /* not JSON: the service ignores it anyway */ }
  return raw
}

function main() {
  if (!ROUTES[EVENT]) return
  const dir = home()
  const raw = withHome(readStdin())
  if (EVENT === 'SessionStart') return sessionStart(raw, dir)
  const d = daemonInfo(dir)
  if (!d) return
  if (EVENT === 'PermissionRequest') {
    return hold(d, raw, (ans) => {
      // N2: only these two fixed answers can ever be printed
      if (ans && ans.d === 'allow') process.stdout.write(ALLOW)
      else if (ans && ans.d === 'deny') process.stdout.write(DENY)
    })
  }
  if (EVENT === 'Stop') {
    return hold(d, raw, (ans) => {
      if (ans && typeof ans.cmd === 'string' && ans.cmd) process.stdout.write(JSON.stringify({ decision: 'block', reason: ans.cmd }))
    })
  }
  // status reports: SessionEnd has 1 s in Codex, the others are not worth waiting for
  send(d, 'POST', ROUTES[EVENT], raw, EVENT === 'SessionEnd' ? 300 : 500, EVENT === 'SessionEnd' ? 600 : 1500, () => {})
}

try { main() } catch (e) { process.exitCode = 0 }
