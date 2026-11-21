'use strict'
// Hinty Agents hook for Claude Code. Registered for two events only (hooks/hooks.json):
//   PermissionRequest  asks the local Hinty Agents service and waits; prints an allow/deny decision only when the
//                      person decided on their glasses or in the Hinty panel. In every other case (service not
//                      running, away mode off, link down, time up, another protocol version, any error) it prints
//                      nothing and exits 0, so Claude Code asks in the terminal as usual.
//   SessionStart       registers the session with the service and, while this computer is paired, adds the
//                      instruction for the one-line glasses summary (the line that starts with 👓).
// Plain CommonJS with lazy requires: it starts in ~70 ms. It never prints anything but the fixed JSON below.
//
// Local protocol v2 (src/localauth.js): the key from daemon.json is never sent; the request is signed with it, and the
// answer counts only with the service's signature over our nonce, the status and the body. Keep in step with
// hooks/common.cjs, claude-plugin/hooks/register.mjs, hermes-plugin/hinty-agents/__init__.py.

const fs = require('fs')

const EVENT = process.argv[2] || ''
const PV = 2
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
const DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Hinty glasses"}}}'
const CONTEXT = 'The user also follows this session on smart glasses that show only one short line. ' +
  'At the end of every response, add one final line that starts with \u{1F453} followed by at most 60 characters: ' +
  'what you did, or what you are asking the user.'

function isAbs(p) {
  if (typeof p !== 'string' || !p || p.indexOf('\0') >= 0) return false
  return process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/]/.test(p) : p.charAt(0) === '/'
}

// HINTY_AGENTS_HOME only as an absolute path; a relative one (it would point into the project) is ignored
function home() {
  const own = process.env.HINTY_AGENTS_HOME
  return own && isAbs(own) ? own : require('path').join(require('os').homedir(), '.hinty-agents')
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return null }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

// daemon.json of a LIVE service of this protocol, else null (a dead service's port may belong to anybody now)
function daemonInfo(dir) {
  const d = readJson(require('path').join(dir, 'daemon.json'))
  if (!d || d.pv !== PV || !Number.isInteger(d.port) || d.port <= 0 || d.port > 65535 || typeof d.key !== 'string' || d.key.length < 32) return null
  if (!Number.isInteger(d.pid) || d.pid <= 0 || !pidAlive(d.pid)) return null
  return d
}

// One signed request to the service. cb(answer) with the parsed JSON, or cb(null) on any failure (N1).
function request(d, method, path, body, timeoutMs, cb) {
  const http = require('http')
  const crypto = require('crypto')
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
  const mac = (m) => crypto.createHmac('sha256', d.key).update(m, 'utf8').digest('hex')
  const nonce = crypto.randomBytes(16).toString('hex')
  const ts = String(Date.now())
  const buf = Buffer.from(body || '', 'utf8')
  let called = false
  const done = (v) => { if (!called) { called = true; cb(v) } }
  const headers = {
    'x-hinty-pv': String(PV), 'x-hinty-ts': ts, 'x-hinty-nonce': nonce, connection: 'close',
    'x-hinty-auth': mac('hinty-req\n' + PV + '\n' + ts + '\n' + nonce + '\n' + method + '\n' + path + '\n' + sha(buf)),
  }
  if (buf.length) { headers['content-type'] = 'application/json'; headers['content-length'] = buf.length }
  const req = http.request({ host: '127.0.0.1', port: d.port, path, method, agent: false, headers }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('error', () => done(null))
    res.on('end', () => {
      if (res.statusCode !== 200) return done(null)
      const raw = Buffer.concat(chunks)
      // the answer must be signed by the service that holds the key, over our nonce
      const want = mac('hinty-res\n' + PV + '\n' + nonce + '\n200\n' + sha(raw))
      const got = String(res.headers['x-hinty-sig'] || '')
      if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return done(null)
      try { done(JSON.parse(raw.toString('utf8'))) } catch (e) { done(null) }
    })
  })
  req.on('error', () => done(null))
  if (timeoutMs) req.setTimeout(timeoutMs, () => { req.destroy(); done(null) })
  req.end(buf.length ? buf : undefined)
}

// Security review 2, Z6: nothing with content goes to the port before the service has proved itself with a signed
// answer to /v1/ping carrying the pid from daemon.json. A process that took the port of a dead service learns nothing
// and cannot hold the hook: an unsigned or missing answer ends the hook within `ms`.
function verified(d, ms, cb) {
  request(d, 'GET', '/v1/ping', '', ms, (ans) => cb(!!ans && ans.ok === true && ans.pid === d.pid))
}

function permission(raw, dir) {
  const d = daemonInfo(dir)
  if (!d) return
  // never outlive Claude Code's own limit (900 s in hooks.json); the service gives up at 840 s
  setTimeout(() => process.exit(0), 895000).unref()
  verified(d, 1500, (ok) => {
    if (!ok) return
    request(d, 'POST', '/v1/hook/permission', raw, 0, (ans) => {
      // N2: only these two fixed answers can ever be printed
      if (ans && ans.d === 'allow') process.stdout.write(ALLOW)
      else if (ans && ans.d === 'deny') process.stdout.write(DENY)
    })
  })
}

// The service to start after a reboot: an installed hinty-agents (…/bin/hinty-agents.js next to its package.json named
// hinty-agents), never a file inside the session's own project folder (security review point 8).
function validEntry(p, cwd) {
  const path = require('path')
  if (!isAbs(p) || path.basename(p) !== 'hinty-agents.js' || path.basename(path.dirname(p)) !== 'bin') return false
  const pkg = readJson(path.join(path.dirname(path.dirname(p)), 'package.json'))
  if (!pkg || pkg.name !== 'hinty-agents') return false
  try {
    const real = fs.realpathSync(p)
    if (isAbs(cwd)) {
      const rel = path.relative(fs.realpathSync(cwd), real)
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return false
    }
    return fs.statSync(real).isFile()
  } catch (e) { return false }
}

function autostart(cfg, input) {
  if (cfg.stopped === true || cfg.autostart === false) return
  const path = require('path')
  let cwd = ''
  try { cwd = String(JSON.parse(input).cwd || '') } catch (e) { /* no cwd */ }
  // the plugin loaded straight from the package: its own entry; otherwise the one recorded at install time
  const own = path.join(__dirname, '..', 'bin', 'hinty-agents.js')
  const entry = validEntry(own, cwd) ? own : validEntry(cfg.entry, cwd) ? cfg.entry : null
  if (!entry) return
  try {
    const env = Object.assign({}, process.env)
    if (process.platform === 'win32') env.NoDefaultCurrentDirectoryInExePath = '1'
    const child = require('child_process').spawn(process.execPath, [entry, 'daemon'],
      { detached: true, stdio: 'ignore', windowsHide: true, cwd: require('os').homedir(), env })
    child.unref()
  } catch (e) { /* the hook never fails the session */ }
}

function sessionStart(raw, dir) {
  const cfg = readJson(require('path').join(dir, 'config.json'))
  if (!cfg || typeof cfg.bridgeToken !== 'string' || cfg.bridgeToken.length < 16) return
  const finish = () => process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONTEXT },
  }))
  const d = daemonInfo(dir)
  if (!d) { autostart(cfg, raw); finish(); return }
  verified(d, 700, (ok) => {
    if (!ok) { autostart(cfg, raw); finish(); return }
    request(d, 'POST', '/v1/hook/session-start', raw, 1500, (ans) => {
      if (!ans) autostart(cfg, raw)
      finish()
    })
  })
}

function doctor(dir) {
  const t0 = Date.now()
  const d = daemonInfo(dir)
  if (!d) { process.stdout.write(JSON.stringify({ ok: false, why: 'not_running' })); return }
  request(d, 'GET', '/v1/ping', '', 3000, (ans) => {
    process.stdout.write(JSON.stringify({ ok: !!(ans && ans.ok && ans.pid === d.pid), ms: Date.now() - t0, pv: PV }))
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
