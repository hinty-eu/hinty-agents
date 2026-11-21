// The desktop app (0.4.0): the bundled Node.js and the worker the app talks to (src/desktop.js).
//  - The Claude Code plugin's hooks.json says `"command": "node"`. A person who installed only the desktop app has no
//    Node.js on PATH: the program copy then names the bundled Node.js by full path (claude.js hookNode, app.js).
//  - Pairing from the window is the wizard's own flow (cli.pairComputer): no check number = refused, 3 tries, a refusal
//    saves nothing; the window can cancel.
//  - The worker answers only its fixed requests, over an IPC channel; in a terminal it refuses to run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hookNode, readHookNode, writeHookNode, checkHookNode, hooksFile } from '../src/adapters/claude.js'
import { verifyCopy } from '../src/app.js'
import { pair } from '../src/pair.js'
import { pairComputer } from '../src/cli.js'
import { installVoice } from '../src/stt/install.js'
import { MODELS, VAD_MODEL } from '../src/stt/models.js'

const REPO = fileURLToPath(new URL('../', import.meta.url))
const CLI = path.join(REPO, 'bin', 'hinty-agents.js')
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version
const WIN = process.platform === 'win32'
const tmp = (p = 'hinty-desk-') => fs.mkdtempSync(path.join(os.tmpdir(), p))
const real = (p) => fs.realpathSync(p)
const NODE = real(process.execPath)
/** a PATH without any Node.js: the system folders only (a person who installed only the desktop app) */
const NO_NODE_PATH = WIN ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'].join(path.delimiter) : '/usr/bin:/bin'

// ---------------------------------------------------------------- the hooks' Node.js

test('hookNode: `node` when this Node.js is the one on PATH, else this Node.js by full path; odd paths never written', () => {
  assert.equal(hookNode(NODE, NODE), 'node')
  assert.equal(hookNode(NODE, null), NODE)
  const other = WIN ? 'C:\\Other\\node.exe' : '/opt/other/node'
  assert.equal(hookNode(NODE, other), NODE, 'another node on PATH: this one by full path')
  for (const bad of ['node.exe', 'relative/node', WIN ? 'C:\\a$b\\node.exe' : '/a$b/node', WIN ? 'C:\\100%\\node.exe' : '/x"y/node']) {
    assert.equal(hookNode(bad, null), 'node', bad)
  }
})

test('writeHookNode changes only our exec-form hooks; `node` leaves the file as it is', () => {
  const root = tmp()
  fs.mkdirSync(path.dirname(hooksFile(root)), { recursive: true })
  const src = fs.readFileSync(hooksFile(REPO), 'utf8')
  fs.writeFileSync(hooksFile(root), src)
  assert.equal(readHookNode(root), 'node')
  assert.equal(writeHookNode(root, 'node'), false)
  assert.equal(fs.readFileSync(hooksFile(root), 'utf8'), src, 'byte for byte')
  assert.equal(writeHookNode(root, NODE), true)
  assert.equal(readHookNode(root), NODE)
  const j = JSON.parse(fs.readFileSync(hooksFile(root), 'utf8'))
  const orig = JSON.parse(src)
  for (const ev of Object.keys(orig.hooks)) {
    assert.deepEqual(j.hooks[ev][0].hooks[0].args, orig.hooks[ev][0].hooks[0].args, 'arguments untouched')
    assert.equal(j.hooks[ev][0].hooks[0].timeout, orig.hooks[ev][0].hooks[0].timeout)
  }
  assert.deepEqual(j.modules, orig.modules)
  // somebody else's hook in the same file (not ours: other args) is never repointed
  j.hooks.Stop = [{ hooks: [{ type: 'command', command: 'node', args: ['other.js'] }] }]
  fs.writeFileSync(hooksFile(root), JSON.stringify(j))
  writeHookNode(root, path.join(os.tmpdir(), 'x', 'node'))
  assert.equal(JSON.parse(fs.readFileSync(hooksFile(root), 'utf8')).hooks.Stop[0].hooks[0].command, 'node')
  assert.equal(readHookNode(root), null, 'mixed commands: no single value')
  assert.equal(checkHookNode(root).ok, false)
})

/** run ensureApp in a child Node.js with this PATH, return the copy root */
function copyWithPath(home, PATH) {
  const code = `import('${pathToUrl(path.join(REPO, 'src', 'app.js'))}').then((m) => { const r = m.ensureApp(); process.stdout.write(JSON.stringify(r)) })`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, PATH, Path: PATH, HINTY_AGENTS_HOME: home, HINTY_AGENTS_DEV: '0' } })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
/** verifyCopy reads the manifest of HINTY_AGENTS_HOME: check with that data folder */
function verifyIn(home, root) {
  const saved = process.env.HINTY_AGENTS_HOME
  process.env.HINTY_AGENTS_HOME = home
  try { return verifyCopy(root, VERSION).ok } finally { if (saved === undefined) delete process.env.HINTY_AGENTS_HOME; else process.env.HINTY_AGENTS_HOME = saved }
}
const pathToUrl = (p) => new URL(`file:///${p.replace(/\\/g, '/').replace(/^\/+/, '')}`).href

test('the program copy names this Node.js in hooks.json when no node is on PATH; the manifest covers it; node on PATH again = copied again', () => {
  const home = tmp()
  const a = copyWithPath(home, NO_NODE_PATH)
  assert.equal(a.copied, true)
  assert.equal(readHookNode(a.root), NODE, 'the bundled runtime by full path')
  assert.equal(readHookNode(REPO), 'node', 'the package itself is never changed')
  assert.equal(verifyIn(home, a.root), true, 'the manifest was made after the change')
  assert.equal(checkHookNode(a.root).ok, true)
  // same runtime again: nothing to do
  assert.equal(copyWithPath(home, NO_NODE_PATH).copied, false)
  // now this Node.js is on PATH (e.g. the person installed Node.js): the copy goes back to `node`
  const b = copyWithPath(home, [path.dirname(process.execPath), NO_NODE_PATH].join(path.delimiter))
  assert.equal(b.copied, true)
  assert.equal(readHookNode(b.root), 'node')
  assert.equal(fs.readFileSync(hooksFile(b.root), 'utf8'), fs.readFileSync(hooksFile(REPO), 'utf8'))
  assert.equal(verifyIn(home, b.root), true)
})

// ---------------------------------------------------------------- pairing from the window

/** a stand-in socket.io client: the test plays the server (as in misc-sec.test.js) */
function fakeIo() {
  const sock = new EventEmitter()
  sock.io = new EventEmitter()
  sock.out = []
  sock.closed = false
  sock.emit2 = sock.emit.bind(sock)
  sock.emit = (ev, p) => { sock.out.push([ev, p]); return true }
  sock.close = () => { sock.closed = true }
  sock.connect = () => {}
  sock.server = (ev, p) => sock.emit2(ev, p)
  return { io: () => sock, sock }
}

/** pairComputer against the fake server; `typed` = what the person types at each try (null = window closed) */
async function pairWith(home, typed, { check = '4821', withHash = true } = {}) {
  const saved = process.env.HINTY_AGENTS_HOME
  process.env.HINTY_AGENTS_HOME = home
  const { io, sock } = fakeIo()
  const seen = { codes: [], claimed: [], mismatch: [], asked: 0 }
  const token = crypto.randomBytes(24).toString('base64url')
  try {
    const p = pairComputer({
      api: 'http://127.0.0.1:9', label: 'test-pc', io,
      onCode: (c) => seen.codes.push(c),
      onClaimed: (a) => seen.claimed.push(a),
      askCheck: async () => { const v = typed[seen.asked++]; return v === undefined ? null : v },
      onMismatch: (left) => seen.mismatch.push(left),
    })
    sock.server('connect')
    sock.server('pair_code', { code: 'ACD4FG', expiresIn: 600 })
    sock.server('paired', { token, bridgeId: 'a'.repeat(24), account: 'a***@g***.com', ...(withHash ? { checkHash: crypto.createHash('sha256').update(`${token}:${check}`).digest('hex') } : {}) })
    return { r: await p, seen, token }
  } finally { if (saved === undefined) delete process.env.HINTY_AGENTS_HOME; else process.env.HINTY_AGENTS_HOME = saved }
}
const savedToken = (home) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).bridgeToken || null } catch { return null } }

test('Z10 from the window: the right number on the second try pairs; the token is saved only then', async () => {
  const home = tmp()
  const { r, seen, token } = await pairWith(home, ['1111', ' 4821 '])
  assert.equal(r.ok, true)
  assert.deepEqual(seen.codes, ['ACD4FG'])
  assert.deepEqual(seen.claimed, ['a***@g***.com'])
  assert.deepEqual(seen.mismatch, [2], 'one wrong try: 2 left')
  assert.equal(savedToken(home), token)
})

test('Z10 from the window: three wrong numbers, a closed window or no check number = refused, nothing saved', { timeout: 60000 }, async () => {
  const cases = [[['1', 'abcd', '0000'], {}, 'mismatch'], [[], {}, 'ended'], [['4821'], { withHash: false }, 'no_check']]
  await Promise.all(cases.map(async ([typed, o, code]) => {
    const home = tmp()
    const { r, seen } = await pairWith(home, typed, o)
    assert.equal(r.ok, false)
    assert.equal(r.stage, 'check')
    assert.equal(r.code, code)
    assert.equal(r.told, false, 'the server (unreachable here) could not be told')
    assert.equal(savedToken(home), null, `${code}: nothing saved`)
    if (code === 'mismatch') assert.deepEqual(seen.mismatch, [2, 1])
  }))
})

test('pair(): the Cancel button (an AbortSignal) closes the connection and rejects with cancelled', async () => {
  const { io, sock } = fakeIo()
  const ctrl = new AbortController()
  const p = pair({ api: 'http://x', io, signal: ctrl.signal, onCode: () => {} })
  sock.server('connect')
  ctrl.abort()
  await assert.rejects(p, /cancelled/)
  assert.equal(sock.closed, true)
  const pre = new AbortController()
  pre.abort()
  await assert.rejects(pair({ api: 'http://x', io: fakeIo().io, signal: pre.signal, onCode: () => {} }), /cancelled/)
})

// ---------------------------------------------------------------- the worker

/** start `hinty-agents desktop` with an IPC channel, like the app does */
function worker(env) {
  const child = spawn(process.execPath, [CLI, 'desktop'], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
  let id = 0
  const waiting = new Map()
  const events = []
  child.on('message', (m) => {
    if (m.t === 'res' && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id) } else if (m.t === 'ev') events.push(m)
  })
  const call = (m, p = {}) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); child.send({ t: 'req', id: n, m, p }) })
  const until = async (pred, ms = 20000) => {
    const t0 = Date.now()
    for (;;) { const e = events.find(pred); if (e) return e; if (Date.now() - t0 > ms) throw new Error('no event'); await new Promise((r) => setTimeout(r, 20)) }
  }
  return { child, call, events, until, close: () => new Promise((r) => { child.on('exit', r); child.disconnect() }) }
}

test('the worker: only over an IPC channel; fixed requests; bundled-style runtime without node on PATH', { timeout: 60000 }, async () => {
  const home = tmp()
  const user = tmp()
  const env = {
    ...process.env, PATH: NO_NODE_PATH, Path: NO_NODE_PATH, HINTY_AGENTS_HOME: home, HINTY_AGENTS_DEV: '0', HINTY_AGENTS_API: 'http://127.0.0.1:9',
    HOME: user, USERPROFILE: user, CLAUDE_CONFIG_DIR: path.join(user, '.claude'), CODEX_HOME: path.join(user, '.codex'), HERMES_HOME: path.join(user, '.hermes'),
    HINTY_AGENTS_NO_NOTIFY: '1', NO_COLOR: '1', DISABLE_AUTOUPDATER: '1',
  }
  // in a terminal (no IPC channel) it refuses
  const plain = spawnSync(process.execPath, [CLI, 'desktop'], { env, encoding: 'utf8', windowsHide: true })
  assert.equal(plain.status, 1)
  assert.match(plain.stdout, /for the Hinty Agents desktop app/)

  const w = worker(env)
  try {
    await w.until((e) => e.ev === 'ready')
    const hello = await w.call('hello')
    assert.equal(hello.ok, true)
    assert.equal(hello.r.runtime, NODE)
    const st = await w.call('state')
    assert.equal(st.r.paired, false)
    assert.equal(st.r.copyError, '')
    assert.equal(st.r.service, null)
    const copy = path.join(home, 'app', VERSION)
    assert.equal(readHookNode(copy), NODE, 'the worker made the program copy for its own Node.js')
    assert.equal((await w.call('nope')).err, 'unknown_method')
    assert.equal((await w.call('__proto__')).err, 'unknown_method')
    assert.equal((await w.call('install', { agent: 'constructor' })).r.code, 1)
    const ra = await w.call('remoteAway', { on: true })
    assert.equal(ra.r.code, 1, 'not paired: refused like the CLI')
    assert.match(ra.r.lines.join('\n'), /Not paired yet/)
    assert.equal(fs.existsSync(path.join(home, 'config.json')), false, 'nothing written')
    assert.equal((await w.call('pairCheck', { digits: '1234' })).r.why, 'not_asking')
    // a pairing the window cancels ends with `cancelled`, nothing saved
    assert.equal((await w.call('pairStart')).r.ok, true)
    assert.equal((await w.call('pairStart')).r.why, 'busy', 'one pairing at a time')
    await w.call('pairCancel')
    const end = await w.until((e) => e.ev === 'pair' && e.d.stage === 'end')
    assert.equal(end.d.ok, false)
    assert.equal(end.d.code, 'cancelled')
    assert.equal(savedToken(home), null)
    const st2 = await w.call('state')
    assert.equal(st2.r.pairing, null)
    assert.equal(st2.r.pairingEnded.code, 'cancelled')
  } finally { await w.close() }
})

test('stop --for-update leaves `stopped` as it was (the new version starts the service again); plain stop sets it', () => {
  const home = tmp()
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 1, api: 'http://127.0.0.1:9', stopped: false }))
  const env = { ...process.env, HINTY_AGENTS_HOME: home, NO_COLOR: '1' }
  const cfg = () => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
  assert.equal(spawnSync(process.execPath, [CLI, 'stop', '--for-update'], { env, windowsHide: true }).status, 0)
  assert.equal(cfg().stopped, false)
  assert.equal(spawnSync(process.execPath, [CLI, 'stop'], { env, windowsHide: true }).status, 0)
  assert.equal(cfg().stopped, true)
})

test('voice install reports progress over the VAD and the model together (for the progress bar)', async () => {
  const home = tmp()
  const saved = { h: process.env.HINTY_AGENTS_HOME, f: globalThis.fetch }
  process.env.HINTY_AGENTS_HOME = home
  const seen = []
  globalThis.fetch = async () => new Response(null, { status: 503 })
  try {
    await assert.rejects(installVoice({ model: 'whisper-small', installEngine: () => {}, progress: (p) => seen.push(p), selfTest: async () => {} }), /download failed \(503\)/)
  } finally { globalThis.fetch = saved.f; if (saved.h === undefined) delete process.env.HINTY_AGENTS_HOME; else process.env.HINTY_AGENTS_HOME = saved.h }
  const total = [VAD_MODEL, 'whisper-small'].reduce((a, id) => a + MODELS[id].files.reduce((b, f) => b + f.size, 0), 0)
  assert.deepEqual(seen[0], { phase: 'engine', done: 0, total })
})
