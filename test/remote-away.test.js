// Security review point 2: the relay (panel, glasses, or anyone who has the Hinty account) can switch away mode ON
// only when the person agreed to that at this computer (config.json remoteAwayOn); OFF always works; a remote ON
// never extends the 12 hours and is always visible locally (log, status, notice).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Service } from '../src/service.js'

const SID = '1281aaaa-0000-4000-8000-0000000000bb'
const relay = () => ({ connected: true, sent: [], emit(ev, p) { this.sent.push([ev, p]) } })

function svc(o = {}) {
  let now = 1_800_000_000_000
  const r = relay()
  const logs = []
  const notices = []
  let allowed = o.allowed ?? false
  const s = new Service({
    relay: r, sessDebounceMs: 0, now: () => now, log: (m, f) => logs.push([m, f]),
    remoteAwayAllowed: () => allowed, onRemoteAway: (at) => notices.push(at), awayMaxMs: 12 * 3600 * 1000,
  })
  return { s, r, logs, notices, tick: (ms) => { now += ms }, allow: (v) => { allowed = v } }
}

test('remote ON without consent: refused, away stays off, the bridge reports off, nothing about the agents leaves', () => {
  const { s, r, logs, notices } = svc()
  s.hookSessionStart({ session_id: SID, cwd: 'E:\\w\\api', source: 'startup' })
  s.onRelay('away', { on: true })
  assert.equal(s.away.isOn(), false)
  assert.deepEqual(r.sent.filter(([e]) => e !== 'hello'), [['away', { on: false }]])
  assert.ok(logs.some(([m, f]) => m === 'away_remote_refused' && f.reason === 'not_allowed_here'))
  assert.equal(notices.length, 0)
  assert.ok(s.status().away.remoteRefusedAt > 0)
  assert.equal(s.status().away.remoteAllowed, false)
  // say / decide / want after a refused switch-on do nothing
  s.onRelay('say', { sid: SID, text: 'rm -rf x' })
  s.onRelay('want', { what: 'state' })
  assert.equal(s.cmds.size, 0)
  assert.ok(!r.sent.some(([e]) => e === 'sess'))
  s.stop()
})

test('remote ON with consent: on, logged, notified, marked as remote for status and the mod', async () => {
  const { s, r, logs, notices } = svc({ allowed: true })
  s.hookSessionStart({ session_id: SID, cwd: 'E:\\w\\api', source: 'startup' })
  s.onRelay('away', { on: true })
  assert.equal(s.away.isOn(), true)
  assert.ok(r.sent.some(([e, p]) => e === 'away' && p.on === true))
  assert.ok(logs.some(([m, f]) => m === 'away_remote_on' && f.result === 'on'))
  assert.equal(notices.length, 1)
  const st = s.status().away
  assert.equal(st.by, 'remote')
  assert.equal(st.since, notices[0])
  const poll = await s.modPoll({ sid: SID, away: true, wait: 0 })
  assert.equal(poll.remote, notices[0], 'the mod learns it was switched on remotely')
  s.stop()
})

test('a remote ON never extends the 12 hours; a local ON does; OFF from the relay always works', () => {
  const { s, tick, notices } = svc({ allowed: true })
  s.onRelay('away', { on: true })
  const until = s.away.until
  tick(11 * 3600 * 1000)
  s.onRelay('away', { on: true })
  assert.equal(s.away.until, until, 'renewing from the relay does not move the end')
  assert.equal(notices.length, 1, 'no second notice for an already-on mode')
  tick(3600 * 1000 + 10)
  assert.equal(s.away.isOn(), false, 'off after 12 h counted from the first switch-on')
  // locally (CLI) a renewal starts 12 h again
  s.setAway(true, 'cli')
  const u2 = s.away.until
  tick(1000)
  s.setAway(true, 'cli')
  assert.ok(s.away.until > u2)
  assert.equal(s.status().away.by, 'cli')
  assert.equal((s.modPoll({ sid: SID, wait: 0 }), s.remoteMark()).remote, undefined, 'switched on locally: no remote mark')
  // OFF from the relay, consent or not
  s.onRelay('away', { on: false })
  assert.equal(s.away.isOn(), false)
  s.stop()
})

test('consent is read at every remote request: withdrawn consent refuses the next switch-on', () => {
  const { s, allow } = svc({ allowed: true })
  s.onRelay('away', { on: true })
  assert.equal(s.away.isOn(), true)
  s.onRelay('away', { on: false })
  allow(false)
  s.onRelay('away', { on: true })
  assert.equal(s.away.isOn(), false)
  s.stop()
})

test('hello carries remoteAway from the consent and a repeated hello follows a change', () => {
  const { s, r, allow } = svc()
  const hellos = () => r.sent.filter(([e]) => e === 'hello').map(([, p]) => p)
  s.hello()
  assert.equal(hellos().at(-1).remoteAway, false)
  allow(true)
  s.agentsChanged()
  assert.equal(hellos().at(-1).remoteAway, true)
  allow(false)
  s.agentsChanged()
  assert.equal(hellos().at(-1).remoteAway, false)
  s.stop()
})
