// N1, N2, N3, N5 at the service level (no network): a fake relay records every outgoing event.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Service } from '../src/service.js'
import { Relay } from '../src/relay.js'
import { PermTable } from '../src/perms.js'
import { permHash } from '../src/crypto.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SID = '1281aaaa-0000-4000-8000-000000000001'
const input = (extra = {}) => ({
  session_id: SID, cwd: 'E:\\work\\hintyApi', hook_event_name: 'PermissionRequest', permission_mode: 'default',
  tool_name: 'Bash', tool_input: { command: 'npm run test:e2e', description: 'run e2e' }, ...extra,
})

function fakeRelay(connected = true) {
  return { connected, sent: [], emit(ev, p) { this.sent.push([ev, p]) } }
}

/** a service with away mode on and a waiting permission request */
function setup(o = {}) {
  const relay = fakeRelay()
  const svc = new Service({ relay, host: 'test-host', sessDebounceMs: 0, ...o })
  svc.setAway(true, 'test')
  return { relay, svc }
}
const lastPerm = (relay) => relay.sent.filter(([e]) => e === 'perm').at(-1)[1]
const settled = async (p, ms = 30) => Promise.race([p.then((v) => ({ v })), sleep(ms).then(() => 'pending')])

// ------------------------------------------------------------------------------------------------
// N1: every failure ends the hook with an empty result
// ------------------------------------------------------------------------------------------------

test('N1: not paired / link down / away off / bad input = empty answer at once', async () => {
  const off = new Service({ relay: fakeRelay(), sessDebounceMs: 0 })
  assert.deepEqual(await off.hookPermission(input()), {})
  const down = new Service({ relay: fakeRelay(false), sessDebounceMs: 0 })
  down.setAway(true, 't')
  assert.deepEqual(await down.hookPermission(input()), {})
  const np = new Service({ relay: fakeRelay(), paired: false, sessDebounceMs: 0 })
  np.setAway(true, 't')
  assert.deepEqual(await np.hookPermission(input()), {})
  const { svc } = setup()
  for (const bad of [null, 'x', [], {}, input({ session_id: 'has space' }), input({ session_id: 'x'.repeat(65) })]) {
    assert.deepEqual(await svc.hookPermission(bad), {})
  }
  svc.stop(); off.stop(); down.stop(); np.stop()
})

test('N1: time up = empty answer and perm_end timeout; 50 time-outs give 0 decisions', async () => {
  const { relay, svc } = setup({ permTtlMs: 40 })
  const answers = await Promise.all(Array.from({ length: 50 }, (_, i) => svc.hookPermission(input({ tool_input: { command: `echo ${i}` } }))))
  assert.equal(answers.length, 50)
  assert.ok(answers.every((a) => Object.keys(a).length === 0), 'every answer is empty')
  assert.equal(relay.sent.filter(([e, p]) => e === 'perm_end' && p.why === 'timeout').length, 50)
  svc.stop()
})

test('N1: perm_refused, link lost, away turned off, hook gone, local answer, stop = empty answers', async () => {
  const { relay, svc } = setup()
  // refused by the relay (limit)
  let p = svc.hookPermission(input())
  svc.onRelay('perm_refused', { rid: lastPerm(relay).rid, why: 'limit' })
  assert.deepEqual(await p, {})
  // link lost
  p = svc.hookPermission(input())
  svc.onRelay('disconnect', { reason: 'transport close' })
  assert.deepEqual(await p, {})
  // away turned off while waiting
  p = svc.hookPermission(input())
  svc.setAway(false, 'cli')
  assert.deepEqual(await p, {})
  svc.setAway(true, 'cli')
  // the hook process went away (Claude Code killed it)
  let abort
  p = svc.hookPermission(input(), { onAbort: (fn) => { abort = fn } })
  const rid = lastPerm(relay).rid
  abort()
  assert.deepEqual(await p, {})
  assert.ok(relay.sent.some(([e, x]) => e === 'perm_end' && x.rid === rid && x.why === 'cancel'))
  // answered at the keyboard: the mod reports later activity of the same session
  p = svc.hookPermission(input())
  const rid2 = lastPerm(relay).rid
  await sleep(5)
  svc.modEvent({ sid: SID, ev: 'tool.check', at: Date.now(), tool: 'Read' })
  assert.deepEqual(await p, {})
  assert.ok(relay.sent.some(([e, x]) => e === 'perm_end' && x.rid === rid2 && x.why === 'local'))
  // service stopping
  p = svc.hookPermission(input())
  svc.stop()
  assert.deepEqual(await p, {})
})

test('N1: activity from before the request, or from another sub-agent, does not close it', async () => {
  const { relay, svc } = setup()
  const before = Date.now() - 1
  const p = svc.hookPermission(input({ agent_id: 'ab10214018071c3d7', agent_type: 'general-purpose' }))
  svc.modEvent({ sid: SID, ev: 'tool.check', at: before, tool: 'Bash', agentId: 'ab10214018071c3d7' })
  await sleep(5)
  svc.modEvent({ sid: SID, ev: 'tool.check', at: Date.now(), tool: 'Read' }) // main loop, not the sub-agent
  assert.equal(await settled(p), 'pending')
  assert.equal(lastPerm(relay).tool, 'Bash › general-purpose')
  svc.modEvent({ sid: SID, ev: 'turn.complete', at: Date.now(), reason: 'answer', agentId: 'ab10214018071c3d7' })
  assert.deepEqual(await p, {})
  svc.stop()
})

// ------------------------------------------------------------------------------------------------
// N2 + N3: only {d:'allow'|'deny'} reaches the hook, and only for a valid decision
// ------------------------------------------------------------------------------------------------

test('N2/N3: a valid decision gives exactly {d}; anything else is ignored and the request keeps waiting', async () => {
  const { relay, svc } = setup()
  const p = svc.hookPermission(input())
  const perm = lastPerm(relay)
  assert.equal(perm.text, 'npm run test:e2e\n\n# run e2e')
  assert.equal(perm.exp, 840)
  assert.match(perm.rid, /^[A-Za-z0-9_-]{22}$/)
  assert.match(perm.hash, /^[0-9a-f]{64}$/)
  assert.equal(perm.hash, permHash({ rid: perm.rid, sid: SID, agentId: null, tool: 'Bash', input: input().tool_input }))
  // the session state went out before the request (the card needs its label)
  const iSess = relay.sent.findIndex(([e, x]) => e === 'sess' && x.st === 'perm')
  const iPerm = relay.sent.findIndex(([e]) => e === 'perm')
  assert.ok(iSess >= 0 && iSess < iPerm)
  assert.equal(relay.sent[iSess][1].label, 'hintyApi')

  const bad = [
    { rid: perm.rid, d: 'allow', hash: perm.hash, updatedInput: { command: 'rm -rf /' } }, // N2
    { rid: perm.rid, d: 'allow', hash: perm.hash, updatedPermissions: [] },
    { rid: perm.rid, d: 'always', hash: perm.hash },
    { rid: perm.rid, d: 'allow' },
    { rid: 'AAAAAAAAAAAAAAAAAAAAAA', d: 'allow', hash: perm.hash }, // N3 foreign rid
    { rid: perm.rid, d: 'allow', hash: 'f'.repeat(64) }, // N3 wrong hash
    { rid: perm.rid, d: 'allow', hash: perm.hash.toUpperCase() },
    null, 'allow', [perm.rid],
  ]
  for (const b of bad) svc.onRelay('decide', b)
  assert.equal(await settled(p), 'pending', 'still waiting after invalid decisions')

  svc.onRelay('decide', { rid: perm.rid, d: 'allow', hash: perm.hash })
  const a = await p
  assert.deepEqual(a, { d: 'allow' })
  assert.deepEqual(Object.keys(a), ['d'])
  svc.stop()
})

test('N3: replayed decision, decision after expiry, and a deny', async () => {
  const { relay, svc } = setup({ permTtlMs: 80 })
  const p1 = svc.hookPermission(input())
  const d1 = lastPerm(relay)
  svc.onRelay('decide', { rid: d1.rid, d: 'deny', hash: d1.hash })
  assert.deepEqual(await p1, { d: 'deny' })
  // a second request: the old decision replayed must not touch it
  const p2 = svc.hookPermission(input())
  svc.onRelay('decide', { rid: d1.rid, d: 'allow', hash: d1.hash })
  assert.equal(await settled(p2), 'pending')
  // after expiry the decision is refused and the hook ended empty
  const d2 = lastPerm(relay)
  assert.deepEqual(await p2, {})
  svc.onRelay('decide', { rid: d2.rid, d: 'allow', hash: d2.hash })
  svc.stop()
})

test('N3 (pure): PermTable refuses away-off, unknown, spent, expired, bad hash; bad hash does not use the rid up', () => {
  let now = 1000
  const t = new PermTable({ now: () => now })
  const p = t.create({ sid: 's', tool: 'Bash', input: { command: 'x' }, text: 'x', ttlMs: 100 })
  assert.equal(t.decide({ rid: p.rid, d: 'allow', hash: p.hash }, { away: false }).reason, 'away_off')
  assert.equal(t.decide({ rid: 'B'.repeat(22), d: 'allow', hash: p.hash }, { away: true }).reason, 'unknown')
  assert.equal(t.decide({ rid: p.rid, d: 'allow', hash: '0'.repeat(64) }, { away: true }).reason, 'bad_hash')
  assert.equal(t.decide({ rid: p.rid, d: 'allow', hash: p.hash }, { away: true }).ok, true)
  assert.equal(t.decide({ rid: p.rid, d: 'allow', hash: p.hash }, { away: true }).reason, 'spent')
  const q = t.create({ sid: 's', tool: 'Bash', input: {}, text: 'y', ttlMs: 100 })
  now += 100
  assert.equal(t.decide({ rid: q.rid, d: 'allow', hash: q.hash }, { away: true }).reason, 'expired')
  assert.notEqual(p.hash, permHash({ rid: p.rid, sid: 's', tool: 'Bash', input: { command: 'y' } }), 'hash binds the input')
})

// ------------------------------------------------------------------------------------------------
// N5: away mode off = nothing about the agents leaves (tapping the real Relay's socket client)
// ------------------------------------------------------------------------------------------------

class TapSocket extends EventEmitter {
  constructor() { super(); this.connected = true; this.active = true; this.out = [] }
  emit(ev, ...args) {
    // outgoing (client -> server) events are recorded; local listener events go through EventEmitter
    if (TapSocket.local.has(ev)) return super.emit(ev, ...args)
    this.out.push([ev, args[0]])
    return true
  }
  serverSends(ev, payload) { super.emit(ev, payload) }
  close() { this.connected = false }
}
TapSocket.local = new Set(['connect', 'disconnect', 'connect_error'])

function wired(o = {}) {
  const sock = new TapSocket()
  const relay = new Relay({ api: 'http://127.0.0.1:9', token: 't'.repeat(32), io: () => sock })
  const svc = new Service({ relay: { get connected() { return relay.connected }, emit: (e, p) => relay.send(e, p) }, sessDebounceMs: 0, ...o })
  relay.on('relay', (ev, p) => svc.onRelay(ev, p))
  relay.start()
  return { sock, relay, svc }
}

test('N5: with away mode off the socket carries only hello/away, never sess, perm or msg', async () => {
  // this test switches away mode on from the relay, so the person has agreed to that here (remoteAwayOn)
  const { sock, relay, svc } = wired({ remoteAwayAllowed: () => true })
  sock.serverSends('ready', { v: 1, bridgeId: 'a'.repeat(24), label: 'pc' })
  const t0 = Date.now()
  assert.deepEqual(await svc.hookPermission(input()), {})
  assert.ok(Date.now() - t0 < 50, 'answers at once')
  svc.hookSessionStart({ session_id: SID, cwd: 'E:\\work\\api', source: 'startup' })
  await svc.modPoll({ sid: SID, cwd: 'E:\\work\\api', wait: 0 })
  svc.modEvent({ sid: SID, ev: 'turn.complete', at: Date.now(), reason: 'answer', answer: 'secret plans\n👓 did it' })
  svc.modEvent({ sid: SID, ev: 'tool.check', at: Date.now(), tool: 'Bash' })
  sock.serverSends('want', { what: 'state' })
  sock.serverSends('want', { sid: SID, what: 'full' })
  sock.serverSends('say', { sid: SID, text: 'do something' })
  await sleep(30)
  assert.deepEqual([...new Set(sock.out.map(([e]) => e))], ['hello'])
  assert.equal(sock.out[0][1].away, false)
  assert.ok(!JSON.stringify(sock.out).includes('secret plans'))
  assert.equal(svc.cmds.size, 0, 'commands are not accepted while away mode is off')
  assert.equal(svc.sessions.get(SID).answer, '', 'nothing from the answer is kept')

  // switching on sends the state; switching off reports it and goes quiet again
  sock.serverSends('away', { on: true })
  await sleep(10)
  assert.ok(sock.out.some(([e, p]) => e === 'away' && p.on === true))
  assert.ok(sock.out.some(([e, p]) => e === 'sess' && p.id === SID))
  sock.serverSends('away', { on: false })
  const n = sock.out.length
  assert.deepEqual(await svc.hookPermission(input()), {})
  svc.modEvent({ sid: SID, ev: 'turn.complete', at: Date.now(), reason: 'answer', answer: 'more' })
  await sleep(20)
  assert.deepEqual(sock.out.slice(n).map(([e]) => e), [])
  assert.deepEqual(sock.out[n - 1], ['away', { on: false }])
  svc.stop(); relay.stop()
})

test('N5: away mode turns itself off after its time and releases waiting hooks', async () => {
  const relay = fakeRelay()
  const svc = new Service({ relay, sessDebounceMs: 0, awayMaxMs: 60 })
  svc.setAway(true, 't')
  const p = svc.hookPermission(input())
  assert.deepEqual(await p, {})
  assert.equal(svc.away.isOn(), false)
  assert.deepEqual(relay.sent.at(-1), ['away', { on: false }])
  svc.stop()
})

test('say: queued only while away is on and for a known session; delivered to that session\'s poll', async () => {
  const { relay, svc } = setup({ pollHoldMs: 500 })
  svc.hookSessionStart({ session_id: SID, cwd: 'C:\\w\\web', source: 'startup' })
  svc.onRelay('say', { sid: 'unknown', text: 'x' })
  svc.onRelay('say', { sid: SID, text: 'x', extra: 1 })
  const poll = svc.modPoll({ sid: SID, cwd: 'C:\\w\\web', wait: 500 })
  await sleep(10)
  svc.onRelay('say', { sid: SID, text: 'run the tests again' })
  const r = await poll
  assert.equal(r.away, true)
  assert.equal(r.cmds.length, 1)
  assert.equal(r.cmds[0].text, 'run the tests again')
  assert.ok(relay.sent.every(([e]) => ['away', 'sess', 'hello'].includes(e)))
  svc.stop()
})

test('turn.complete: 👓 line, done state, full answer only on request (masked)', async () => {
  const { relay, svc } = setup()
  svc.hookSessionStart({ session_id: SID, cwd: '/w/api', source: 'startup' })
  svc.modEvent({ sid: SID, ev: 'turn.complete', at: Date.now(), reason: 'answer', answer: 'Key sk-ant-abcdefghijklmnop123 rotated.\n👓 Rotated the API key' })
  svc.flushSess()
  const s = relay.sent.filter(([e]) => e === 'sess').at(-1)[1]
  assert.equal(s.st, 'done')
  assert.equal(s.line, 'Rotated the API key')
  assert.ok(!relay.sent.some(([e]) => e === 'msg'))
  svc.onRelay('want', { sid: SID, what: 'full' })
  const m = relay.sent.find(([e]) => e === 'msg')[1]
  assert.ok(m.text.includes('sk-ant-***') && !m.text.includes('abcdefghijklmnop123'))
  svc.stop()
})

test('session.end: a poll still in flight does not bring the session back; a new SessionStart does', async () => {
  const { relay, svc } = setup()
  await svc.modPoll({ sid: SID, cwd: '/w/api', wait: 0 })
  svc.modEvent({ sid: SID, ev: 'session.end', at: Date.now() })
  assert.deepEqual(relay.sent.filter(([e, p]) => e === 'sess' && p.st === 'end').length, 1)
  await svc.modPoll({ sid: SID, cwd: '/w/api', wait: 0 })
  svc.modEvent({ sid: SID, ev: 'tool.check', at: Date.now(), tool: 'Read' })
  assert.equal(svc.sessions.get(SID), null)
  svc.hookSessionStart({ session_id: SID, cwd: '/w/api', source: 'resume' })
  assert.ok(svc.sessions.get(SID))
  svc.stop()
})
