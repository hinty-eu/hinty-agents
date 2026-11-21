'use strict'
// Hinty Agents hook for Grok Build. Registered in ~/.grok/hooks/hinty.json (argv[2] = the event, argv[3] = hold seconds):
//   SessionStart, UserPromptSubmit, Stop, SessionEnd  short status reports; they never print anything
//                      (Grok ignores the output of these events).
//   PreToolUse         only with `install grok --ask-shell`: asks the service about a shell command and waits. It prints a
//                      veto ({"decision":"deny",...}, exit 2) only when the person denied on their glasses or panel.
//                      Grok FAILS OPEN: on any problem, or when the time is up, the step simply runs (and Grok's own
//                      permission checks still apply). "Allow" from the glasses only means "no veto".
// Prints nothing but the fixed JSON below.

const { home, daemonInfo, request, readStdin } = require('./common.cjs')

const EVENT = process.argv[2] || ''
const HOLD_S = Number(process.argv[3]) || 0
const ROUTES = {
  SessionStart: '/v1/hook/grok/session-start',
  UserPromptSubmit: '/v1/hook/grok/prompt',
  Stop: '/v1/hook/grok/stop',
  SessionEnd: '/v1/hook/grok/session-end',
  PreToolUse: '/v1/hook/grok/pre-tool',
}
const DENY = '{"decision":"deny","reason":"Denied from Hinty glasses"}'

function main() {
  if (!ROUTES[EVENT]) return
  const raw = readStdin()
  const d = daemonInfo(home())
  if (!d) return
  if (EVENT === 'PreToolUse') {
    // leave before Grok's own timeout (hinty.json: hold + 20 s); the service gives up at hold seconds
    if (HOLD_S) setTimeout(() => process.exit(0), (HOLD_S + 10) * 1000).unref()
    return request(d, 'POST', ROUTES.PreToolUse, raw, 0, (ans) => {
      if (ans && ans.d === 'deny') {
        process.stdout.write(DENY)
        process.stderr.write('Denied from Hinty glasses')
        process.exitCode = 2
      }
    })
  }
  request(d, 'POST', ROUTES[EVENT], raw, EVENT === 'SessionEnd' ? 700 : 1500, () => {})
}

try { main() } catch (e) { process.exitCode = 0 }
