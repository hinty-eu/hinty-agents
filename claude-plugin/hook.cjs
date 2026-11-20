'use strict'
// Hinty Agents hook for Claude Code. Registered for two events only (hooks/hooks.json):
//   PermissionRequest  asks the local Hinty Agents service and waits; prints an allow/deny decision only when the
//                      person decided on their glasses or in the Hinty panel. In every other case (service not
//                      running, away mode off, link down, time up, any error) it prints nothing and exits 0, so
//                      Claude Code asks in the terminal as usual.
//   SessionStart       registers the session with the service and, while this computer is paired, adds the
//                      instruction for the one-line glasses summary (the line that starts with 👓).
// Plain CommonJS with lazy requires: it starts in ~70 ms. It never prints anything but the fixed JSON below.

const fs = require('fs')

const EVENT = process.argv[2] || ''
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
const DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Hinty glasses"}}}'
const CONTEXT = 'The user also follows this session on smart glasses that show only one short line. ' +
  'At the end of every response, add one final line that starts with \u{1F453} followed by at most 60 characters: ' +
  'what you did, or what you are asking the user.'

function home() {
  return process.env.HINTY_AGENTS_HOME || require('path').join(require('os').homedir(), '.hinty-agents')
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return null }
}

function daemonInfo(dir) {
  const d = readJson(dir + '/daemon.json')
  if (!d || !Number.isInteger(d.port) || d.port <= 0 || d.port > 65535 || typeof d.secret !== 'string') return null
  return d
}

// One request to the service. cb(answer) with the parsed JSON, or cb(null) on any failure (N1).
function request(d, method, path, body, timeoutMs, cb) {
  const http = require('http')
  const crypto = require('crypto')
  const nonce = crypto.randomBytes(16).toString('hex')
  let called = false
  const done = (v) => { if (!called) { called = true; cb(v) } }
  const headers = { 'x-hinty-secret': d.secret, 'x-hinty-nonce': nonce, connection: 'close' }
  if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body) }
  const req = http.request({ host: '127.0.0.1', port: d.port, path, method, agent: false, headers }, (res) => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', (c) => { text += c })
    res.on('error', () => done(null))
    res.on('end', () => {
      if (res.statusCode !== 200) return done(null)
      // the answer must prove it comes from the service that holds the secret
      const want = crypto.createHmac('sha256', d.secret).update(nonce + '\n' + text, 'utf8').digest('hex')
      const got = String(res.headers['x-hinty-proof'] || '')
      if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return done(null)
      try { done(JSON.parse(text)) } catch (e) { done(null) }
    })
  })
  req.on('error', () => done(null))
  if (timeoutMs) req.setTimeout(timeoutMs, () => { req.destroy(); done(null) })
  req.end(body || undefined)
}

function permission(raw, dir) {
  const d = daemonInfo(dir)
  if (!d) return
  // never outlive Claude Code's own limit (900 s in hooks.json); the service gives up at 840 s
  setTimeout(() => process.exit(0), 895000).unref()
  request(d, 'POST', '/v1/hook/permission', raw, 0, (ans) => {
    // N2: only these two fixed answers can ever be printed
    if (ans && ans.d === 'allow') process.stdout.write(ALLOW)
    else if (ans && ans.d === 'deny') process.stdout.write(DENY)
  })
}

function autostart(cfg) {
  if (cfg.stopped === true || cfg.autostart === false || typeof cfg.entry !== 'string') return
  try {
    if (!fs.existsSync(cfg.entry)) return
    const child = require('child_process').spawn(process.execPath, [cfg.entry, 'daemon'],
      { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch (e) { /* the hook never fails the session */ }
}

function sessionStart(raw, dir) {
  const cfg = readJson(dir + '/config.json')
  if (!cfg || typeof cfg.bridgeToken !== 'string' || cfg.bridgeToken.length < 16) return
  const finish = () => process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONTEXT },
  }))
  const d = daemonInfo(dir)
  if (!d) { autostart(cfg); finish(); return }
  request(d, 'POST', '/v1/hook/session-start', raw, 1500, (ans) => {
    if (!ans) autostart(cfg)
    finish()
  })
}

function doctor(dir) {
  const t0 = Date.now()
  const d = daemonInfo(dir)
  if (!d) { process.stdout.write(JSON.stringify({ ok: false, why: 'not_running' })); return }
  request(d, 'GET', '/v1/ping', '', 3000, (ans) => {
    process.stdout.write(JSON.stringify({ ok: !!(ans && ans.ok), ms: Date.now() - t0 }))
  })
}

function main() {
  const dir = home()
  if (EVENT === 'Doctor') return doctor(dir)
  let raw = ''
  try { raw = fs.readFileSync(0, 'utf8') } catch (e) { return }
  if (EVENT === 'PermissionRequest') return permission(raw, dir)
  if (EVENT === 'SessionStart') return sessionStart(raw, dir)
}

try { main() } catch (e) { process.exitCode = 0 }
