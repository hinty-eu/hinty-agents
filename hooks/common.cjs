'use strict'
// Shared helpers of the Codex and Grok hook scripts (plain CommonJS, lazy requires, no dependencies).
// Same rules as claude-plugin/hook.cjs: whatever goes wrong, the caller prints nothing and exits 0 (N1), and an answer
// counts only when it carries the HMAC proof of the service that holds the secret in daemon.json (N9).

const fs = require('fs')

// Instruction for the one-line glasses summary (same words as claude-plugin/hook.cjs and src/text.js).
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

// Start the service in the background after a reboot (only when paired and not stopped on purpose).
function autostart(cfg) {
  if (!cfg || cfg.stopped === true || cfg.autostart === false || typeof cfg.entry !== 'string') return
  try {
    if (!fs.existsSync(cfg.entry)) return
    const child = require('child_process').spawn(process.execPath, [cfg.entry, 'daemon'],
      { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch (e) { /* a hook never fails the session */ }
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8') } catch (e) { return '' }
}

module.exports = { CONTEXT, home, readJson, daemonInfo, request, autostart, readStdin }
