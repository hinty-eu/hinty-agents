'use strict'
// Shared helpers of the Codex and Grok hook scripts (plain CommonJS, lazy requires, no dependencies).
// Same rules as claude-plugin/hook.cjs: whatever goes wrong, the caller prints nothing and exits 0 (N1). Local protocol
// v2 (src/localauth.js): requests are signed with the key from daemon.json (the key never travels) and an answer counts
// only with the service's signature over our nonce, the status and the body (N9).

const fs = require('fs')

const PV = 2
// Instruction for the one-line glasses summary (same words as claude-plugin/hook.cjs and src/text.js).
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
  // a part ending in a space, a tab or a dot is another folder for Windows tools than for Node: refused like a relative path
  const odd = (p) => require('path').resolve(p).split(/[\\/]/).some((seg) => /[ \t.]$/.test(seg))
  return own && isAbs(own) && !odd(own) ? own : require('path').join(require('os').homedir(), '.hinty-agents')
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

// Security review 2, Z6: nothing with content goes to the port before the service has proved itself with a signed
// answer to /v1/ping carrying the pid from daemon.json; an unsigned or missing answer ends the hook within `ms`.
function verified(d, ms, cb) {
  request(d, 'GET', '/v1/ping', '', ms, (ans) => cb(!!ans && ans.ok === true && ans.pid === d.pid))
}

// verified first, then one signed request with content; cb(null) when the service did not prove itself
function send(d, method, path, body, pingMs, timeoutMs, cb) {
  verified(d, pingMs, (ok) => { if (!ok) return cb(null); request(d, method, path, body, timeoutMs, cb) })
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
      const want = mac('hinty-res\n' + PV + '\n' + nonce + '\n200\n' + sha(raw))
      const got = String(res.headers['x-hinty-sig'] || '')
      // 64 lowercase hex characters first: a header with other bytes never reaches timingSafeEqual (review 3, P4)
      if (!/^[0-9a-f]{64}$/.test(got) || !crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'))) return done(null)
      try { done(JSON.parse(raw.toString('utf8'))) } catch (e) { done(null) }
    })
  })
  req.on('error', () => done(null))
  if (timeoutMs) req.setTimeout(timeoutMs, () => { req.destroy(); done(null) })
  req.end(buf.length ? buf : undefined)
}

// The service to start: an installed hinty-agents (…/bin/hinty-agents.js next to its package.json named hinty-agents),
// never a file inside the session's own project folder (security review point 8).
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

// Start the service in the background after a reboot (only when paired and not stopped on purpose).
function autostart(cfg, cwd) {
  if (!cfg || cfg.stopped === true || cfg.autostart === false || !validEntry(cfg.entry, cwd)) return
  try {
    const env = Object.assign({}, process.env)
    if (process.platform === 'win32') env.NoDefaultCurrentDirectoryInExePath = '1'
    const child = require('child_process').spawn(process.execPath, [cfg.entry, 'daemon'],
      { detached: true, stdio: 'ignore', windowsHide: true, cwd: require('os').homedir(), env })
    child.unref()
  } catch (e) { /* a hook never fails the session */ }
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8') } catch (e) { return '' }
}

module.exports = { PV, CONTEXT, home, readJson, daemonInfo, request, verified, send, autostart, validEntry, readStdin, isAbs }
