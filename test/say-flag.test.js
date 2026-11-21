// `sess` is a full description of a session for the server: a session that takes no commands (Grok Build) says
// `say:false` in EVERY `sess` event; sessions that take commands never carry the field.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Service } from '../src/service.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('every sess event of a Grok session carries say:false (start, run, done, end); Claude and Codex sessions never do', async () => {
  const sent = []
  const service = new Service({ relay: { connected: true, emit: (ev, p) => sent.push([ev, p]) }, paired: true, sessDebounceMs: 5 })
  service.setAway(true, 'test')
  service.agentSessionStart('grok', { sessionId: 'grok-1', cwd: '/w/g' })
  service.agentActivity('grok', { sessionId: 'grok-1', cwd: '/w/g' })
  service.agentStopState('grok', { sessionId: 'grok-1', cwd: '/w/g', lastAssistantMessage: 'done' })
  service.hookSessionStart({ session_id: 'claude-1', cwd: '/w/c' })
  service.sessions.touch({ sid: 'codex-1', cwd: '/w/x', agent: 'codex' })
  service.queueSess('codex-1')
  await sleep(40)
  service.sendAll() // a full resend (reconnect / want state) too
  service.agentSessionEnd('grok', { sessionId: 'grok-1', cwd: '/w/g' })
  const sess = sent.filter((e) => e[0] === 'sess').map((e) => e[1])
  const grok = sess.filter((s) => s.id === 'grok-1')
  assert.ok(grok.length >= 3, `got ${grok.length}`)
  assert.ok(grok.every((s) => s.say === false), JSON.stringify(grok))
  assert.ok(grok.some((s) => s.st === 'end'))
  for (const id of ['claude-1', 'codex-1']) {
    const mine = sess.filter((s) => s.id === id)
    assert.ok(mine.length >= 1)
    assert.ok(mine.every((s) => !('say' in s)), `${id}: ${JSON.stringify(mine)}`)
  }
  service.stop()
})

test('say to a session that takes no commands is refused, not queued', () => {
  const logs = []
  const service = new Service({ relay: { connected: true, emit() {} }, paired: true, log: (m, f) => logs.push([m, f]) })
  service.setAway(true, 'test')
  service.agentSessionStart('grok', { sessionId: 'grok-2', cwd: '/w' })
  service.onRelay('say', { sid: 'grok-2', text: 'hello' })
  assert.equal((service.cmds.get('grok-2') || []).length, 0)
  assert.ok(logs.some((l) => l[0] === 'say_refused' && l[1].reason === 'unsupported'))
  service.stop()
})
