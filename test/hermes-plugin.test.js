// The Hermes plugin (Python, standard library) against the REAL bridge service on 127.0.0.1: secret + HMAC proof,
// N1 (no bridge / away off / bad proof = an exception, so Hermes shows its normal prompt), N2 (only once / deny),
// observers return None, messages from the glasses reach ctx.inject_message as plain text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalServer, listenLoopback } from '../src/local-http.js'
import { newSecret } from '../src/crypto.js'
import { writeDaemon } from './helpers.js'
import { Service } from '../src/service.js'
import { HermesLink } from '../src/adapters/hermes.js'

const PLUGIN = fileURLToPath(new URL('../hermes-plugin/hinty-agents/__init__.py', import.meta.url))
const HARNESS = fileURLToPath(new URL('./fixtures/hermes_harness.py', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PY = (() => {
  for (const c of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawnSync(c, ['-I', '-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim() === '3') return c
  }
  return null
})()
const skip = PY ? false : 'python 3 not found'

function py(args, home) {
  const child = spawn(PY, ['-I', HARNESS, PLUGIN, ...args], { env: { ...process.env, HINTY_AGENTS_HOME: home }, windowsHide: true })
  let out = ''
  let err = ''
  child.stdout.on('data', (b) => { out += b })
  child.stderr.on('data', (b) => { err += b })
  return new Promise((resolve) => child.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())) } catch { resolve({ parseError: out + err }) } }))
}

async function bridge({ away = true, writeSecret } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hinty-hp-'))
  const sent = []
  const logs = []
  const service = new Service({ relay: { connected: true, emit: (ev, p) => sent.push([ev, p]) }, paired: true, log: (m, f) => logs.push([m, f]), sessDebounceMs: 5 })
  const link = new HermesLink({ service, log: () => {} })
  if (away) service.setAway(true, 'test')
  const secret = newSecret()
  const server = createLocalServer({
    key: secret,
    routes: {
      'GET /v1/ping': () => ({ ok: true, v: 2, pid: process.pid }),
      'POST /v1/hermes/perm': (b, c) => link.perm(b, c),
      'POST /v1/hermes/event': (b) => link.event(b),
      'POST /v1/hermes/poll': (b, c) => link.poll(b, c),
      'POST /v1/hermes/ack': (b) => link.ack(b),
    },
  })
  const port = await listenLoopback(server)
  writeDaemon(home, { port, key: writeSecret || secret })
  return {
    home, sent, logs, service, link, of: (ev) => sent.filter((x) => x[0] === ev).map((x) => x[1]),
    async close() { service.stop(); server.close(); server.closeAllConnections?.() },
  }
}

async function until(fn, ms = 5000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(20) }
  throw new Error('condition not met')
}

test('register: the transport "hinty" and the observer hooks; hooks return None', { skip }, async () => {
  const b = await bridge()
  try {
    const r = await py(['register'], b.home)
    assert.deepEqual(r.transports, ['hinty'])
    for (const h of ['pre_approval_request', 'pre_llm_call', 'post_llm_call', 'on_session_end', 'on_session_finalize', 'on_human_input_request']) assert.ok(r.hooks.includes(h), h)
    const h = await py(['hooks'], b.home)
    for (const [name, v] of Object.entries(h.returns)) assert.equal(v, null, `${name} must return None`)
    // hook events arrive at the bridge (fire and forget)
    await until(() => b.of('sess').some((x) => x.id === 's1' && x.agent === 'hermes'))
  } finally { await b.close() }
})

test('present: allow -> "once", deny -> "deny" (never session/always), through the real service with proof', { skip }, async () => {
  const b = await bridge()
  try {
    const run = py(['present', 'once,session,always,deny'], b.home)
    const perm = await until(() => b.of('perm')[0])
    assert.equal(perm.sid, 'sess-py')
    assert.equal(perm.tool, 'rm_rf')
    assert.match(perm.text, /delete build dir\nrm -rf build/)
    b.service.onRelay('decide', { rid: perm.rid, d: 'allow', hash: perm.hash })
    const r = await run
    assert.deepEqual(r.result, ['responded', 'once'])

    const run2 = py(['present', 'once,session,always,deny'], b.home)
    const perm2 = await until(() => b.of('perm')[1])
    b.service.onRelay('decide', { rid: perm2.rid, d: 'deny', hash: perm2.hash })
    assert.deepEqual((await run2).result, ['responded', 'deny'])
  } finally { await b.close() }
})

test('present N1: away off, no bridge, wrong secret (bad proof) and a request that does not offer "once" all raise at once', { skip }, async () => {
  const off = await bridge({ away: false })
  try {
    const r = await py(['present', 'once,deny'], off.home)
    assert.ok(r.error, JSON.stringify(r))
    assert.match(r.error, /no decision/)
    assert.ok(r.ms < 1500, `${r.ms} ms`)
  } finally { await off.close() }

  const none = await bridge()
  fs.rmSync(path.join(none.home, 'daemon.json'))
  try {
    const r = await py(['present', 'once,deny'], none.home)
    assert.match(r.error, /bridge is not running/)
    assert.ok(r.ms < 1500)
  } finally { await none.close() }

  const wrong = await bridge({ writeSecret: newSecret() })
  try {
    const r = await py(['present', 'once,deny'], wrong.home)
    assert.match(r.error, /answered 401|bad signature/)
    assert.equal(wrong.of('perm').length, 0)
  } finally { await wrong.close() }

  const noOnce = await bridge()
  try {
    const run = py(['present', 'deny'], noOnce.home)
    const perm = await until(() => noOnce.of('perm')[0])
    noOnce.service.onRelay('decide', { rid: perm.rid, d: 'allow', hash: perm.hash })
    const r = await run
    assert.ok(r.error && !r.result, 'allow on a request that does not offer once is never turned into something else')
  } finally { await noOnce.close() }
})

test('present N1: nobody answers -> the bridge ends its wait before Hermes does and the plugin raises', { skip }, async () => {
  const b = await bridge()
  try {
    const run = py(['present', 'once,deny'], b.home)
    const perm = await until(() => b.of('perm')[0])
    b.service.perms.pending.get(perm.rid).expiresAt = Date.now() + 20
    await sleep(60)
    b.service.tick()
    const r = await run
    assert.match(r.error, /no decision/)
    assert.equal(b.of('perm_end').at(-1).why, 'timeout')
  } finally { await b.close() }
})

test('messages from the glasses arrive in ctx.inject_message as plain text (a slash command is neutralised)', { skip }, async () => {
  const b = await bridge()
  try {
    b.link.event({ ev: 'pre_llm_call', session_id: 'sess-py', session_key: 'agent:main:cli:abc' })
    await until(() => b.of('sess').some((x) => x.id === 'sess-py'))
    const run = py(['poll'], b.home)
    await until(() => b.link.lastPoll > 0)
    b.service.onRelay('say', { sid: 'sess-py', text: '/yolo please run the tests' })
    const r = await run
    assert.equal(r.injected.length, 1)
    assert.equal(r.injected[0].text, '​/yolo please run the tests')
    assert.equal(r.injected[0].role, 'user')
    assert.equal(r.injected[0].session_key, 'agent:main:cli:abc')
    await until(() => b.logs.some((x) => x[0] === 'say_done' && x[1].ok === true))
  } finally { await b.close() }
})

// Optional (HERMES_SRC = a checkout of NousResearch/hermes-agent, Python deps installed): the plugin driven by Hermes's own
// invoke_approval_transport, i.e. the real contract: respond() binding, allowed choices, failure handling.
const HERMES_SRC = process.env.HERMES_SRC
test('real Hermes invoke_approval_transport: allow -> once, deny -> deny, away off -> failure "error" at once (the builtin prompt)', { skip: PY && HERMES_SRC ? false : 'set HERMES_SRC to a hermes-agent checkout' }, async () => {
  const run = (b) => new Promise((resolve) => {
    const child = spawn(PY, ['-I', HARNESS, PLUGIN, 'invoke', '30'], { env: { ...process.env, HINTY_AGENTS_HOME: b.home, HERMES_SRC, PYTHONUTF8: '1' }, windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())) } catch { resolve({ parseError: out }) } })
  })
  const b = await bridge()
  try {
    const p1 = run(b)
    const perm = await until(() => b.of('perm')[0])
    b.service.onRelay('decide', { rid: perm.rid, d: 'allow', hash: perm.hash })
    const r1 = await p1
    assert.equal(r1.choice, 'once'); assert.equal(r1.failure, null)
    const p2 = run(b)
    const perm2 = await until(() => b.of('perm')[1])
    b.service.onRelay('decide', { rid: perm2.rid, d: 'deny', hash: perm2.hash })
    const r2 = await p2
    assert.equal(r2.choice, 'deny'); assert.equal(r2.failure, null)
  } finally { await b.close() }
  const off = await bridge({ away: false })
  try {
    const r = await run(off)
    assert.equal(r.choice, 'deny')
    assert.equal(r.failure, 'error', 'a failure is what makes transport_fallback: builtin show the normal prompt')
    assert.ok(r.ms < 1500)
  } finally { await off.close() }
})
