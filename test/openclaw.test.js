// OpenClaw adapter against a fake Gateway (real WebSocket, real Ed25519 check): pairing, protocol negotiation, N1 (no
// answer = nothing sent), N2 (only allow-once / deny), N12 (say is plain text), the token never leaves, and the link
// exists only while the service is live (paired, link up, away on).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Service } from '../src/service.js'
import * as oc from '../src/adapters/openclaw.js'
import { activeAgents } from '../src/adapters/index.js'
import { startGateway } from './fixtures/fake-gateway.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

async function until(fn, ms = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(10) }
  throw new Error('condition not met: ' + fn.toString().slice(0, 100))
}

/** A Service with a recording relay, an OpenClawLink wired the way the daemon does it. */
function setup(gw, { retryMs = 50 } = {}) {
  const sent = []
  const logs = []
  const relay = { connected: true, emit: (ev, payload) => sent.push([ev, payload]) }
  const service = new Service({ relay, paired: true, log: (m, f) => logs.push([m, f]), sessDebounceMs: 5 })
  const link = new oc.OpenClawLink({ service, log: (m, f) => logs.push([m, f]), retryMs })
  service.attachAgent('openclaw', { say: (sid, text) => link.say(sid, text) })
  service.onLive((live) => { if (live) link.start(); else link.stop() })
  return { sent, logs, relay, service, link, of: (ev) => sent.filter((e) => e[0] === ev).map((e) => e[1]) }
}

async function env(gw, opts) {
  const home = tmp('hinty-oc-home-')
  const saved = process.env.HINTY_AGENTS_HOME
  process.env.HINTY_AGENTS_HOME = home
  const cfgDir = tmp('hinty-oc-cfg-')
  const cfg = path.join(cfgDir, 'openclaw.json')
  const savedCfg = [process.env.OPENCLAW_CONFIG_PATH, process.env.OPENCLAW_STATE_DIR, process.env.OPENCLAW_GATEWAY_TOKEN, process.env.OPENCLAW_GATEWAY_PORT]
  process.env.OPENCLAW_CONFIG_PATH = cfg
  process.env.OPENCLAW_STATE_DIR = cfgDir
  delete process.env.OPENCLAW_GATEWAY_TOKEN
  process.env.OPENCLAW_GATEWAY_PORT = String(gw.port)
  // JSON5-ish on purpose: a comment and a trailing comma
  fs.writeFileSync(cfg, `{\n  // the user's file\n  gateway: { port: ${gw.port}, auth: { mode: 'token', token: 'shared-token-AAAA', }, },\n}\n`)
  return {
    home, cfgDir, cfg,
    restore() {
      if (saved === undefined) delete process.env.HINTY_AGENTS_HOME; else process.env.HINTY_AGENTS_HOME = saved
      ;['OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_GATEWAY_PORT'].forEach((k, i) => { if (savedCfg[i] === undefined) delete process.env[k]; else process.env[k] = savedCfg[i] })
    },
  }
}

const approval = (id, over = {}) => ({
  id,
  request: { command: 'mkdir hinty-e5', cwd: '/work', host: 'gateway', agentId: 'main', sessionKey: 'agent:main:main', turnSourceChannel: 'webchat', ...over },
  createdAtMs: Date.now(), expiresAtMs: Date.now() + 60000,
})

test('install pairs once (protocol 4 -> 3), stores only the device token (0600), never the shared one', async () => {
  const gw = await startGateway({ protocol: 3 })
  const e = await env(gw)
  try {
    const r = await oc.install()
    assert.equal(r.ok, true, JSON.stringify(r.steps))
    assert.deepEqual(gw.connects.map((c) => c.maxProtocol), [4, 3], 'offered 4, then spoke the Gateway\'s 3')
    assert.equal(gw.connects[1].auth.token, 'shared-token-AAAA', 'the first connection uses the shared token')
    assert.deepEqual(gw.connects[1].scopes, ['operator.read', 'operator.write', 'operator.approvals'], 'never operator.admin')
    const t = JSON.parse(fs.readFileSync(path.join(e.home, 'openclaw', 'token.json'), 'utf8'))
    assert.equal(t.deviceToken, 'device-token-SECRET')
    for (const f of fs.readdirSync(path.join(e.home, 'openclaw'))) {
      assert.ok(!fs.readFileSync(path.join(e.home, 'openclaw', f), 'utf8').includes('shared-token-AAAA'), `${f} must not hold the shared token`)
    }
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(e.home, 'openclaw', 'token.json')).mode & 0o077, 0)
    assert.deepEqual(activeAgents(), ['claude', 'openclaw'])
    // the user's own configuration is untouched
    assert.match(fs.readFileSync(e.cfg, 'utf8'), /the user's file/)
    const u = oc.uninstall()
    assert.equal(u.ok, true)
    assert.ok(u.steps.some((s) => /openclaw devices remove [0-9a-f]{64}/.test(s.message)))
    assert.equal(fs.existsSync(path.join(e.home, 'openclaw')), false)
    assert.deepEqual(activeAgents(), ['claude'])
  } finally { e.restore(); await gw.close() }
})

test('protocol 4 Gateway is spoken to directly; a SecretRef token asks for --token-file; a bad token is reported', async () => {
  const gw = await startGateway({ protocol: 4 })
  const e = await env(gw)
  try {
    const r = await oc.install()
    assert.equal(r.ok, true)
    assert.deepEqual(gw.connects.map((c) => c.maxProtocol), [4])
    oc.uninstall()
    fs.writeFileSync(e.cfg, `{ gateway: { port: ${gw.port}, auth: { mode: 'token', token: { source: 'file', provider: 'x', id: '/y' } } } }`)
    const r2 = await oc.install()
    assert.equal(r2.ok, false)
    assert.match(r2.steps.map((s) => s.message).join('|'), /--token-file/)
    const tf = path.join(e.cfgDir, 'tok.txt')
    fs.writeFileSync(tf, 'wrong-token\n')
    const r3 = await oc.install({ tokenFile: tf })
    assert.equal(r3.ok, false)
    assert.match(r3.steps.map((s) => s.message).join('|'), /wrong Gateway token|unauthorized/)
    fs.writeFileSync(tf, 'shared-token-AAAA\n')
    assert.equal((await oc.install({ tokenFile: tf })).ok, true)
  } finally { e.restore(); await gw.close() }
})

test('the link exists only while live: away off = no connection at all; away on = connects; off again = disconnects', async () => {
  const gw = await startGateway()
  const e = await env(gw)
  try {
    assert.equal((await oc.install()).ok, true)
    await until(() => gw.clients === 0)
    const before = gw.connects.length
    const s = setup(gw)
    await sleep(150)
    assert.equal(gw.connects.length, before, 'service started, away off: no connect')
    s.service.setAway(true, 'test')
    await until(() => gw.clients === 1)
    s.service.setAway(false, 'test')
    await until(() => gw.clients === 0)
    // link down while away is on: no connection either
    s.service.setAway(true, 'test')
    await until(() => gw.clients === 1)
    s.relay.connected = false
    s.service.onRelay('disconnect', {})
    await until(() => gw.clients === 0)
    s.service.stop()
  } finally { e.restore(); await gw.close() }
})

test('approval: allow -> allow-once, deny -> deny; the card carries our rid and hash, never OpenClaw\'s id; tokens never leave', async () => {
  const gw = await startGateway()
  const e = await env(gw)
  try {
    assert.equal((await oc.install()).ok, true)
    await until(() => gw.clients === 0) // the install's own connection is gone
    const s = setup(gw)
    s.service.setAway(true, 'test')
    await until(() => gw.clients === 1)

    gw.emit('exec.approval.requested', approval('oc-id-1'))
    const perm = await until(() => s.of('perm')[0])
    assert.notEqual(perm.rid, 'oc-id-1')
    assert.equal(perm.tool, 'exec')
    assert.match(perm.text, /mkdir hinty-e5\ncwd: \/work/)
    assert.equal(perm.sid, 'agent:main:main')
    assert.ok(perm.exp >= 50 && perm.exp <= 60)
    const sess = s.of('sess').find((x) => x.id === 'agent:main:main')
    assert.equal(sess.agent, 'openclaw')
    assert.equal(sess.label, 'main')
    assert.equal(sess.st, 'perm')
    assert.ok(!('say' in sess), 'OpenClaw takes commands: no say field')
    s.service.onRelay('decide', { rid: perm.rid, d: 'allow', hash: perm.hash })
    const r1 = await until(() => gw.requests.find((r) => r.method === 'exec.approval.resolve'))
    assert.deepEqual(r1.params, { id: 'oc-id-1', decision: 'allow-once' })

    gw.requests.length = 0
    gw.emit('exec.approval.requested', approval('oc-id-2'))
    const perm2 = await until(() => s.of('perm')[1])
    s.service.onRelay('decide', { rid: perm2.rid, d: 'deny', hash: perm2.hash })
    const r2 = await until(() => gw.requests.find((r) => r.method === 'exec.approval.resolve'))
    assert.deepEqual(r2.params, { id: 'oc-id-2', decision: 'deny' })

    // a wrong hash decides nothing
    gw.requests.length = 0
    gw.emit('exec.approval.requested', approval('oc-id-3'))
    const perm3 = await until(() => s.of('perm')[2])
    s.service.onRelay('decide', { rid: perm3.rid, d: 'allow', hash: 'f'.repeat(64) })
    await sleep(100)
    assert.equal(gw.requests.filter((r) => r.method === 'exec.approval.resolve').length, 0)

    // nothing that left the computer (relay events, logs) holds a token
    const everything = JSON.stringify(s.sent) + JSON.stringify(s.logs)
    for (const secret of ['device-token-SECRET', 'shared-token-AAAA']) assert.ok(!everything.includes(secret), `${secret} leaked`)
    s.service.stop()
  } finally { e.restore(); await gw.close() }
})

test('N2: whatever the person or a bug does, only allow-once / deny can be sent', async () => {
  assert.equal(oc.decisionFor('allow'), 'allow-once')
  for (const d of ['deny', 'allow-always', 'always', 'full', '', null, undefined, 1, {}]) assert.equal(oc.decisionFor(d), 'deny', String(d))
  const gw = await startGateway()
  const e = await env(gw)
  try {
    assert.equal((await oc.install()).ok, true)
    await until(() => gw.clients === 0) // the install's own connection is gone
    const s = setup(gw)
    s.service.setAway(true, 'test')
    await until(() => gw.clients === 1)
    for (const bad of ['allow-always', 'always', '', 'allow']) assert.throws(() => s.link.resolve('exec', 'x', bad), /refused decision/)
    s.service.stop()
  } finally { e.restore(); await gw.close() }
})

test('N1: nobody answers -> the card times out and NOTHING is sent to the Gateway; a spent card cannot be decided later', async () => {
  const gw = await startGateway()
  const e = await env(gw)
  try {
    assert.equal((await oc.install()).ok, true)
    await until(() => gw.clients === 0) // the install's own connection is gone
    const s = setup(gw)
    s.service.setAway(true, 'test')
    await until(() => gw.clients === 1)
    gw.emit('exec.approval.requested', { ...approval('oc-id-9'), expiresAtMs: Date.now() + 5700 }) // exp = 0.7 s after our 5 s margin
    // too short for a person to answer: no card at all, OpenClaw's own timeout decides
    await sleep(150)
    assert.equal(s.of('perm').length, 0)
    gw.emit('exec.approval.requested', { ...approval('oc-id-10'), expiresAtMs: Date.now() + 10200 })
    const perm = await until(() => s.of('perm')[0])
    assert.equal(perm.exp, 0 + Math.floor(perm.exp)) // an integer
    s.service.perms.pending.get(perm.rid).expiresAt = Date.now() + 20
    await until(() => s.of('perm_end').some((x) => x.rid === perm.rid && x.why === 'timeout'), 8000)
    s.service.onRelay('decide', { rid: perm.rid, d: 'allow', hash: perm.hash })
    await sleep(100)
    assert.equal(gw.requests.filter((r) => /approval.resolve/.test(r.method)).length, 0, 'no resolve, ever')
    s.service.stop()
  } finally { e.restore(); await gw.close() }
})

test('an answer from another window closes the card at once (perm_end local) and we send nothing', async () => {
  const gw = await startGateway()
  const e = await env(gw)
  try {
    assert.equal((await oc.install()).ok, true)
    await until(() => gw.clients === 0) // the install's own connection is gone
    const s = setup(gw)
    s.service.setAway(true, 'test')
    await until(() => gw.clients === 1)
    gw.emit('exec.approval.requested', approval('oc-id-5'))
    const perm = await until(() => s.of('perm')[0])
    const t0 = Date.now()
    gw.emit('exec.approval.resolved', { id: 'oc-id-5', decision: 'allow-once', resolvedBy: 'Control UI', ts: Date.now() })
    const end = await until(() => s.of('perm_end').find((x) => x.rid === perm.rid))
    assert.equal(end.why, 'local')
    assert.ok(Date.now() - t0 < 500)
    assert.equal(gw.requests.filter((r) => /approval.resolve/.test(r.method)).length, 0)
    // plugin approvals use their own method
    gw.emit('plugin.approval.requested', { id: 'pl-1', request: { pluginId: 'mailer', title: 'Send the offer?', description: 'To: client', toolName: 'send_mail', sessionKey: 'agent:main:main' }, createdAtMs: Date.now(), expiresAtMs: Date.now() + 60000 })
    const p2 = await until(() => s.of('perm')[1])
    assert.equal(p2.tool, 'send_mail')
    assert.match(p2.text, /Send the offer\?\nTo: client/)
    s.service.onRelay('decide', { rid: p2.rid, d: 'allow', hash: p2.hash })
    const r = await until(() => gw.requests.find((x) => x.method === 'plugin.approval.resolve'))
    assert.deepEqual(r.params, { id: 'pl-1', decision: 'allow-once' })
    s.service.stop()
  } finally { e.restore(); await gw.close() }
})

test('losing the Gateway closes open cards (cancel) and the link reconnects with the device token', async () => {
  const gw = await startGateway()
  const e = await env(gw)
  try {
    assert.equal((await oc.install()).ok, true)
    await until(() => gw.clients === 0) // the install's own connection is gone
    const s = setup(gw)
    s.service.setAway(true, 'test')
    await until(() => gw.clients === 1)
    gw.emit('exec.approval.requested', approval('oc-id-6'))
    const perm = await until(() => s.of('perm')[0])
    for (const sock of gw.sockets) sock.terminate()
    const end = await until(() => s.of('perm_end').find((x) => x.rid === perm.rid))
    assert.equal(end.why, 'cancel')
    await until(() => s.logs.filter((l) => l[0] === 'oc_up').length === 2)
    assert.equal(gw.connects.at(-1).auth.token, 'device-token-SECRET')
    s.service.stop()
  } finally { e.restore(); await gw.close() }
})

test('a pending approval is replayed on connect when the Gateway can list them (2026.11)', async () => {
  const gw = await startGateway({ protocol: 4 })
  gw.handlers['exec.approval.list'] = () => ({ approvals: [approval('oc-old-1')] })
  const e = await env(gw)
  try {
    assert.equal((await oc.install()).ok, true)
    await until(() => gw.clients === 0) // the install's own connection is gone
    const s = setup(gw)
    s.service.setAway(true, 'test')
    const perm = await until(() => s.of('perm')[0])
    s.service.onRelay('decide', { rid: perm.rid, d: 'deny', hash: perm.hash })
    const r = await until(() => gw.requests.find((x) => x.method === 'exec.approval.resolve'))
    assert.deepEqual(r.params, { id: 'oc-old-1', decision: 'deny' })
    s.service.stop()
  } finally { e.restore(); await gw.close() }
})

test('sessions: state from events, last answer on `want full`, at most 8 sessions, long keys hashed', async () => {
  const gw = await startGateway()
  gw.handlers['sessions.list'] = () => ({ sessions: [] })
  const e = await env(gw)
  try {
    assert.equal((await oc.install()).ok, true)
    await until(() => gw.clients === 0) // the install's own connection is gone
    const s = setup(gw)
    s.service.setAway(true, 'test')
    await until(() => gw.clients === 1)
    gw.emit('sessions.changed', { sessionKey: 'agent:main:main', phase: 'start', runId: 'r1', session: { key: 'agent:main:main', deliveryContext: { channel: 'webchat' } } })
    await until(() => s.of('sess').some((x) => x.id === 'agent:main:main' && x.st === 'run'))
    gw.emit('session.message', { sessionKey: 'agent:main:main', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.\n👓 backup finished' }] } })
    gw.emit('chat', { sessionKey: 'agent:main:main', state: 'final', runId: 'r1' })
    const done = await until(() => s.of('sess').find((x) => x.id === 'agent:main:main' && x.st === 'done'))
    assert.equal(done.line, 'backup finished')
    s.service.onRelay('want', { what: 'full', sid: 'agent:main:main' })
    assert.match((await until(() => s.of('msg')[0])).text, /backup finished/)
    // a Telegram session gets the channel in its label
    gw.emit('sessions.changed', { sessionKey: 'agent:publisher:telegram:42', phase: 'start', session: { deliveryContext: { channel: 'telegram' } } })
    const tg = await until(() => s.of('sess').find((x) => x.id === 'agent:publisher:telegram:42'))
    assert.equal(tg.label, 'publisher·telegram')
    // a very long key gets a short id
    const longKey = 'agent:main:' + 'x'.repeat(100)
    gw.emit('sessions.changed', { sessionKey: longKey, phase: 'start', session: {} })
    const long = await until(() => s.of('sess').find((x) => x.id.startsWith('oc-')))
    assert.match(long.id, /^oc-[0-9a-f]{20}$/)
    for (let i = 0; i < 12; i++) gw.emit('sessions.changed', { sessionKey: `agent:w${i}:main`, phase: 'start', session: {} })
    await sleep(300)
    assert.ok(s.service.sessions.list().filter((x) => x.agent === 'openclaw').length <= oc.MAX_SESSIONS)
    s.service.stop()
  } finally { e.restore(); await gw.close() }
})

test('say: chat.send with a plain message (N12): /approve, ! and inline slash directives are neutralised', async () => {
  const gw = await startGateway()
  gw.handlers['chat.send'] = () => ({ runId: 'r', status: 'started' })
  const e = await env(gw)
  try {
    assert.equal((await oc.install()).ok, true)
    await until(() => gw.clients === 0) // the install's own connection is gone
    const s = setup(gw)
    s.service.setAway(true, 'test')
    await until(() => gw.clients === 1)
    gw.emit('sessions.changed', { sessionKey: 'agent:main:main', phase: 'start', session: {} })
    await until(() => s.of('sess').some((x) => x.id === 'agent:main:main'))
    const Z = '​'
    for (const [text, want] of [
      ['run the tests', 'run the tests'],
      ['/approve abc allow-always', `${Z}/approve abc allow-always`],
      ['  /exec security=full ask=off', `${Z}/exec security=full ask=off`],
      ['! rm -rf x', `${Z}! rm -rf x`],
      ['please /elevated full then go', `please ${Z}/elevated full then go`],
      ['first\n/approve 1 allow-always', `first\n${Z}/approve 1 allow-always`],
    ]) {
      gw.requests.length = 0
      s.service.onRelay('say', { sid: 'agent:main:main', text })
      const req = await until(() => gw.requests.find((r) => r.method === 'chat.send'))
      assert.equal(req.params.message, want, JSON.stringify(text))
      assert.equal(req.params.sessionKey, 'agent:main:main')
      assert.match(req.params.idempotencyKey, /^[0-9a-f-]{36}$/)
    }
    // unknown session: nothing sent
    gw.requests.length = 0
    s.service.onRelay('say', { sid: 'nope', text: 'x' })
    await sleep(100)
    assert.equal(gw.requests.length, 0)
    s.service.stop()
  } finally { e.restore(); await gw.close() }
})

test('doctor warns about askFallback: full; labels and ids', async () => {
  const gw = await startGateway()
  const e = await env(gw)
  try {
    fs.writeFileSync(path.join(e.cfgDir, 'exec-approvals.json'), JSON.stringify({ version: 1, defaults: { security: 'allowlist', askFallback: 'full' } }))
    assert.equal(oc.askFallbackFull().length, 1)
    const r = await oc.install()
    assert.ok(r.steps.some((x) => x.step === 'WARNING' && /askFallback: full/.test(x.message)))
    const lines = await oc.doctor()
    assert.ok(lines.some((l) => /Gateway reachable/.test(l.text) && l.ok === true))
    assert.ok(lines.some((l) => /askFallback/.test(l.text) && l.ok === null))
    fs.writeFileSync(path.join(e.cfgDir, 'exec-approvals.json'), JSON.stringify({ defaults: { askFallback: 'deny' } }))
    assert.equal(oc.askFallbackFull().length, 0)
  } finally { e.restore(); await gw.close() }
  assert.equal(oc.labelFor('agent:main:main'), 'main')
  assert.equal(oc.labelFor('agent:publisher:telegram:5', 'telegram'), 'publisher·telegram')
  assert.equal(oc.sidFor('agent:main:main'), 'agent:main:main')
  assert.equal(oc.messageText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')
})

test('parseLoose reads JSON5-style openclaw.json', () => {
  const j = oc.parseLoose("{ // c\n gateway: { port: 18789, auth: { mode: 'token', token: 'abc', }, }, /* x */ list: [1,2,], }")
  assert.equal(j.gateway.auth.token, 'abc')
  assert.equal(j.gateway.port, 18789)
})
