// Hermes adapter: install / uninstall / doctor with a fake `hermes` CLI (settings restored, the dangerous combination
// never left behind) and the live part (HermesLink) against a real Service: N1, N2, state, `say` through the plugin's poll.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service } from '../src/service.js'
import * as hermes from '../src/adapters/hermes.js'
import { activeAgents } from '../src/adapters/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-hermes.mjs', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

function env(version) {
  const keys = ['HERMES_HOME', 'HINTY_AGENTS_HOME', 'HINTY_AGENTS_HERMES', 'FAKE_HERMES_LOG', 'FAKE_HERMES_VERSION']
  const saved = keys.map((k) => process.env[k])
  const e = { hermesHome: tmp('hinty-hermes-home-'), home: tmp('hinty-hermes-bridge-'), log: path.join(tmp('hinty-hermes-log-'), 'calls.log') }
  process.env.HERMES_HOME = e.hermesHome
  process.env.HINTY_AGENTS_HOME = e.home
  process.env.HINTY_AGENTS_HERMES = FAKE
  process.env.FAKE_HERMES_LOG = e.log
  if (version) process.env.FAKE_HERMES_VERSION = version; else delete process.env.FAKE_HERMES_VERSION
  fs.writeFileSync(e.log, '')
  e.calls = () => fs.readFileSync(e.log, 'utf8').trim().split('\n').filter(Boolean)
  e.yaml = () => { try { return fs.readFileSync(path.join(e.hermesHome, 'config.yaml'), 'utf8') } catch { return '' } }
  e.restore = () => keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i] })
  return e
}

test('yamlGet reads nested keys of a block-style config', () => {
  const t = 'security:\n  approval:\n    mode: smart\n    transport: hinty # c\n    transport_fallback: "builtin"\nplugins:\n  entries:\n    hinty-agents:\n      allow_gateway_injection: true\nother:\n  transport: no\n'
  assert.equal(hermes.yamlGet(t, ['security', 'approval', 'transport']), 'hinty')
  assert.equal(hermes.yamlGet(t, ['security', 'approval', 'transport_fallback']), 'builtin')
  assert.equal(hermes.yamlGet(t, ['plugins', 'entries', 'hinty-agents', 'allow_gateway_injection']), 'true')
  assert.equal(hermes.yamlGet(t, ['security', 'approval', 'nope']), undefined)
  assert.equal(hermes.cmpVersion('0.23.3', '0.21.5'), 1)
  assert.equal(hermes.cmpVersion('0.21.4', '0.21.5'), -1)
})

test('install: plugin copied, fallback builtin BEFORE transport hinty; uninstall restores what the person had', () => {
  const e = env()
  try {
    fs.writeFileSync(path.join(e.hermesHome, 'x'), '')
    fs.writeFileSync(path.join(e.hermesHome, 'config.json'), JSON.stringify({ security: { approval: { mode: 'smart', transport: 'ntfy', transport_fallback: 'deny' } } }))
    fs.writeFileSync(path.join(e.hermesHome, 'config.yaml'), 'security:\n  approval:\n    mode: smart\n    transport: ntfy\n    transport_fallback: deny\n')
    const r = hermes.install()
    assert.equal(r.ok, true, JSON.stringify(r.steps))
    assert.ok(fs.existsSync(path.join(e.hermesHome, 'plugins', 'hinty-agents', '__init__.py')))
    assert.ok(fs.existsSync(path.join(e.hermesHome, 'plugins', 'hinty-agents', 'plugin.yaml')))
    const calls = e.calls()
    assert.deepEqual(calls, [
      'plugins enable hinty-agents',
      'config set security.approval.transport_fallback builtin',
      'config set plugins.entries.hinty-agents.allow_gateway_injection true',
      'config set security.approval.transport hinty',
    ])
    assert.ok(calls.findIndex((c) => /transport_fallback/.test(c)) < calls.findIndex((c) => /transport hinty/.test(c)), 'fallback first')
    assert.equal(hermes.readSettings().transport, 'hinty')
    assert.equal(hermes.readSettings().fallback, 'builtin')
    assert.deepEqual(activeAgents(), ['claude', 'hermes'])
    // installing again keeps the person's ORIGINAL values in the backup (not our own)
    assert.equal(hermes.install().ok, true)
    assert.equal(JSON.parse(fs.readFileSync(hermes.backupFile(), 'utf8')).transport, 'ntfy')

    fs.writeFileSync(e.log, '')
    const u = hermes.uninstall()
    assert.equal(u.ok, true, JSON.stringify(u.steps))
    assert.deepEqual(e.calls(), [
      'config set security.approval.transport ntfy',
      'config set security.approval.transport_fallback deny',
      'config set plugins.entries.hinty-agents.allow_gateway_injection false',
      'plugins disable hinty-agents',
    ])
    assert.equal(hermes.readSettings().transport, 'ntfy')
    assert.equal(hermes.readSettings().fallback, 'deny')
    assert.equal(fs.existsSync(path.join(e.hermesHome, 'plugins', 'hinty-agents')), false)
    assert.equal(fs.existsSync(hermes.backupFile()), false)
    assert.deepEqual(activeAgents(), ['claude'])
  } finally { e.restore() }
})

test('uninstall without any earlier settings goes back to Hermes defaults; never leaves transport hinty behind', () => {
  const e = env()
  try {
    assert.equal(hermes.install().ok, true)
    assert.equal(hermes.readSettings().transport, 'hinty')
    assert.equal(hermes.uninstall().ok, true)
    assert.equal(hermes.readSettings().transport, 'builtin')
    assert.equal(hermes.readSettings().fallback, 'deny')
    assert.notEqual(hermes.readSettings().injection, 'true')
  } finally { e.restore() }
})

test('uninstall leaves a transport that is not ours alone; install refuses an old Hermes and a foreign plugin folder', () => {
  const e = env()
  try {
    assert.equal(hermes.install().ok, true)
    // the person switched to another transport meanwhile
    fs.writeFileSync(path.join(e.hermesHome, 'config.yaml'), 'security:\n  approval:\n    transport: ntfy\n    transport_fallback: builtin\n')
    fs.writeFileSync(e.log, '')
    assert.equal(hermes.uninstall().ok, true)
    assert.ok(!e.calls().some((c) => /approval\.transport ntfy|approval\.transport builtin/.test(c)), 'transport untouched')
  } finally { e.restore() }
  const old = env('0.20.0')
  try {
    const r = hermes.install()
    assert.equal(r.ok, false)
    assert.match(r.steps.at(-1).message, /older than 0\.21\.5/)
    assert.equal(old.calls().length, 0, 'nothing changed')
  } finally { old.restore() }
  const foreign = env()
  try {
    const dst = path.join(foreign.hermesHome, 'plugins', 'hinty-agents')
    fs.mkdirSync(dst, { recursive: true })
    fs.writeFileSync(path.join(dst, '__init__.py'), '# somebody else\n')
    const r = hermes.install()
    assert.equal(r.ok, false)
    assert.equal(fs.readFileSync(path.join(dst, '__init__.py'), 'utf8'), '# somebody else\n')
    assert.equal(foreign.calls().length, 0)
  } finally { foreign.restore() }
})

test('doctor flags the dangerous combination: transport hinty with fallback deny, or without the plugin', () => {
  const e = env()
  try {
    assert.equal(hermes.install().ok, true)
    assert.ok(hermes.doctor().every((l) => l.ok !== false))
    fs.writeFileSync(path.join(e.hermesHome, 'config.yaml'), 'security:\n  approval:\n    transport: hinty\n    transport_fallback: deny\n')
    assert.ok(hermes.doctor().some((l) => l.ok === false && /transport_fallback/.test(l.text)))
    fs.rmSync(path.join(e.hermesHome, 'plugins', 'hinty-agents'), { recursive: true })
    assert.ok(hermes.doctor().some((l) => l.ok === false && /plugin is missing/.test(l.text)))
  } finally { e.restore() }
})

// ------------------------------------------------------------------------------------------------

function live({ away = true, connected = true } = {}) {
  const sent = []
  const logs = []
  const relay = { connected, emit: (ev, payload) => sent.push([ev, payload]) }
  const service = new Service({ relay, paired: true, log: (m, f) => logs.push([m, f]), sessDebounceMs: 5 })
  const link = new hermes.HermesLink({ service, log: (m, f) => logs.push([m, f]) })
  if (away) service.setAway(true, 'test')
  return { sent, logs, relay, service, link, of: (ev) => sent.filter((x) => x[0] === ev).map((x) => x[1]) }
}
const req = (over = {}) => ({
  request_id: 'req-1', digest: 'd'.repeat(16), session_key: 'agent:main:cli:abc', session_id: 'sess-1', surface: 'cli',
  command: 'rm -rf build', description: 'delete build dir', pattern_key: 'rm_rf', timeout_seconds: 300, allowed_choices: ['once', 'session', 'always', 'deny'], ...over,
})
async function until(fn, ms = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(10) }
  throw new Error('condition not met: ' + fn.toString().slice(0, 100))
}

test('perm: away on -> a card, allow -> {d:allow}, deny -> {d:deny}; the answer never carries session/always', async () => {
  const l = live()
  const p = l.link.perm(req())
  const perm = await until(() => l.of('perm')[0])
  assert.equal(perm.tool, 'rm_rf')
  assert.equal(perm.sid, 'sess-1')
  assert.equal(perm.text, 'delete build dir\nrm -rf build')
  assert.ok(perm.exp > 280 && perm.exp <= 293, 'ends before the plugin gives up and before Hermes does')
  assert.equal(l.of('sess').find((x) => x.id === 'sess-1').agent, 'hermes')
  l.service.onRelay('decide', { rid: perm.rid, d: 'allow', hash: perm.hash })
  assert.deepEqual(await p, { d: 'allow' })
  const p2 = l.link.perm(req({ request_id: 'req-2' }))
  const perm2 = await until(() => l.of('perm')[1])
  l.service.onRelay('decide', { rid: perm2.rid, d: 'deny', hash: perm2.hash })
  assert.deepEqual(await p2, { d: 'deny' })
  l.service.stop()
})

test('N1/N5: away off, link down, unpaired, bad body, or no time left = {d:null} AT ONCE and no card', async () => {
  const off = live({ away: false })
  const t0 = Date.now()
  assert.deepEqual(await off.link.perm(req()), { d: null })
  assert.ok(Date.now() - t0 < 50)
  assert.equal(off.sent.filter((x) => x[0] === 'perm').length, 0)
  const down = live({ connected: false })
  assert.deepEqual(await down.link.perm(req()), { d: null })
  down.service.stop()
  const on = live()
  assert.deepEqual(await on.link.perm('x'), { d: null })
  assert.deepEqual(await on.link.perm(req({ timeout_seconds: 8 })), { d: null }, 'too short to be worth a card')
  assert.deepEqual(await on.link.perm(req({ session_id: '', session_key: '' })), { d: null })
  assert.equal(on.of('perm').length, 0)
  on.service.stop()
})

test('N1: nobody answers -> the card times out and the plugin gets {d:null}; away off while waiting releases it; a late decide is refused', async () => {
  const l = live()
  const p = l.link.perm(req())
  const perm = await until(() => l.of('perm')[0])
  l.service.perms.pending.get(perm.rid).expiresAt = Date.now() + 20
  await sleep(40)
  l.service.tick()
  assert.deepEqual(await p, { d: null })
  assert.equal(l.of('perm_end').at(-1).why, 'timeout')
  l.service.onRelay('decide', { rid: perm.rid, d: 'allow', hash: perm.hash })
  assert.ok(l.logs.some((x) => x[0] === 'decide_refused'))

  const q = l.link.perm(req({ request_id: 'req-9' }))
  await until(() => l.of('perm')[1])
  l.service.setAway(false, 'test')
  assert.deepEqual(await q, { d: null })
  l.service.stop()
})

test('the plugin aborting its request (Hermes took over) cancels the card', async () => {
  const l = live()
  let abort
  const p = l.link.perm(req(), { onAbort: (fn) => { abort = fn } })
  const perm = await until(() => l.of('perm')[0])
  abort()
  assert.deepEqual(await p, { d: null })
  assert.equal(l.of('perm_end').find((x) => x.rid === perm.rid).why, 'cancel')
  l.service.stop()
})

test('events: run / done with the glasses line / ask / end; nothing is kept while away is off', async () => {
  const l = live()
  l.link.event({ ev: 'pre_llm_call', session_id: 'sess-1', session_key: 'k1', platform: 'cli' })
  await until(() => l.of('sess').some((x) => x.id === 'sess-1' && x.st === 'run'))
  assert.equal(l.of('sess').find((x) => x.id === 'sess-1').label, 'hermes')
  l.link.event({ ev: 'post_llm_call', session_id: 'sess-1', text: 'All done.\n👓 build cleaned' })
  const done = await until(() => l.of('sess').find((x) => x.id === 'sess-1' && x.st === 'done'))
  assert.equal(done.line, 'build cleaned')
  l.service.onRelay('want', { what: 'full', sid: 'sess-1' })
  assert.match(l.of('msg')[0].text, /build cleaned/)
  l.link.event({ ev: 'on_human_input_request', session_id: 'sess-1', kind: 'clarify' })
  await until(() => l.of('sess').some((x) => x.st === 'ask'))
  l.link.event({ ev: 'on_session_end', session_id: 'sess-1', outcome: 'failed' })
  await until(() => l.of('sess').some((x) => x.st === 'err'))
  l.link.event({ ev: 'on_session_finalize', session_id: 'sess-1' })
  await until(() => l.of('sess').some((x) => x.st === 'end'))
  l.service.stop()
  const off = live({ away: false })
  assert.deepEqual(off.link.event({ ev: 'pre_llm_call', session_id: 'sess-2' }), { ok: true, away: false })
  assert.equal(off.service.sessions.list().length, 0)
})

test('say: queued as a plain message (N12) for the plugin\'s poll, acked by the plugin; no poll = refused; away off clears', async () => {
  const l = live()
  l.link.event({ ev: 'pre_llm_call', session_id: 'sess-1', session_key: 'agent:main:cli:abc' })
  await until(() => l.of('sess').some((x) => x.id === 'sess-1'))
  // the plugin has not polled yet: nothing to deliver to
  l.service.onRelay('say', { sid: 'sess-1', text: 'hello' })
  await sleep(50)
  assert.equal(l.link.queue.length, 0)
  // the plugin polls (idle poll held), then a message arrives
  const poll = l.link.poll({ wait: 5, can_say: true })
  await sleep(20)
  l.service.onRelay('say', { sid: 'sess-1', text: '/yolo' })
  const r = await poll
  assert.equal(r.cmds.length, 1)
  assert.equal(r.cmds[0].text, '​/yolo', 'a slash command is neutralised before it reaches Hermes')
  assert.equal(r.cmds[0].session_key, 'agent:main:cli:abc')
  l.link.ack({ id: r.cmds[0].id, ok: true })
  await until(() => l.logs.some((x) => x[0] === 'say_done' && x[1].ok === true && x[1].via === 'hermes'))
  // away off: queued messages are dropped
  l.link.poll({ wait: 0 })
  l.service.onRelay('say', { sid: 'sess-1', text: 'later' })
  l.service.setAway(false, 'test')
  l.link.clear()
  assert.equal(l.link.queue.length, 0)
  l.service.stop()
})

test('say:false when the plugin cannot inject (ctx has no inject_message)', async () => {
  const l = live()
  await l.link.poll({ wait: 0, can_say: false })
  l.link.event({ ev: 'pre_llm_call', session_id: 'sess-1' })
  const s = await until(() => l.of('sess')[0])
  assert.equal(s.say, false)
  l.service.stop()
})
