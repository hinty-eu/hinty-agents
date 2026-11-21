// Codex adapter: hooks.json merge / undo (the user's own entries stay), hook input normalizing, the hook process
// (N1: no service = silent and fast, N2: only the fixed answers print), and the service's Codex flows (permission card,
// Stop hold with a follow-up instruction, limits, away mode off).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as codex from '../src/adapters/codex.js'
import { activeAgents } from '../src/adapters/index.js'
import { createLocalServer, listenLoopback } from '../src/local-http.js'
import { Service } from '../src/service.js'

const HOOK = fileURLToPath(new URL('../hooks/codex-hook.cjs', import.meta.url))
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
const DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Hinty glasses"}}}'
const SID = '01a1fb5e-5fbd-7c70-ab44-bbbe57828f20'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

/** point the adapter at throw-away folders for one test */
function envs() {
  const codexHome = tmp('hinty-codex-')
  const home = tmp('hinty-home-')
  const saved = { c: process.env.CODEX_HOME, h: process.env.HINTY_AGENTS_HOME, g: process.env.HINTY_AGENTS_GROK_HOME }
  process.env.CODEX_HOME = codexHome
  process.env.HINTY_AGENTS_HOME = home
  process.env.HINTY_AGENTS_GROK_HOME = tmp('hinty-grok-')
  return { codexHome, home, restore() { for (const [k, v] of [['CODEX_HOME', saved.c], ['HINTY_AGENTS_HOME', saved.h], ['HINTY_AGENTS_GROK_HOME', saved.g]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v } } }
}

const theirs = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine', timeout: 5 }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo their-stop' }] }] }, description: 'my hooks' }

test('merge adds six Hinty hooks next to the user\'s, is idempotent, and strip gives the original back', () => {
  const e = envs()
  try {
    const merged = codex.merge(theirs)
    assert.equal(merged.description, 'my hooks')
    assert.equal(merged.hooks.PreToolUse.length, 1)
    assert.equal(merged.hooks.Stop.length, 2, 'their Stop plus ours')
    for (const [ev, timeout] of codex.EVENTS) {
      const ours = merged.hooks[ev].flatMap((g) => g.hooks).filter((h) => h.command.includes('codex-hook.cjs'))
      assert.equal(ours.length, 1, ev)
      assert.equal(ours[0].timeout, timeout)
      assert.match(ours[0].command, new RegExp(` ${ev}$`))
    }
    assert.deepEqual(codex.merge(merged), merged, 'a second merge changes nothing')
    assert.deepEqual(codex.strip(merged), theirs)
    assert.deepEqual(codex.strip({}), {})
    assert.deepEqual(codex.strip(null), {})
  } finally { e.restore() }
})

test('install: scripts copied, backup kept once, file merged; uninstall restores; a broken file is left alone', () => {
  const e = envs()
  try {
    const file = path.join(e.codexHome, 'hooks.json')
    fs.writeFileSync(file, JSON.stringify(theirs, null, 2))
    const r = codex.install()
    assert.equal(r.ok, true)
    assert.ok(fs.existsSync(path.join(e.home, 'hooks', 'codex-hook.cjs')) && fs.existsSync(path.join(e.home, 'hooks', 'common.cjs')))
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.codexHome, codex.BAK), 'utf8')), theirs)
    assert.equal(codex.installed().complete, true)
    assert.deepEqual(activeAgents(), ['claude', 'codex'])
    codex.install() // again: backup is not overwritten with our own version
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.codexHome, codex.BAK), 'utf8')), theirs)
    assert.equal(codex.installed().events.length, 6)
    assert.equal(codex.uninstall().ok, true)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), theirs)
    assert.equal(codex.installed().installed, false)
    assert.deepEqual(activeAgents(), ['claude'])
    // broken JSON: nothing is written
    fs.writeFileSync(file, '{not json')
    const bad = codex.install()
    assert.equal(bad.ok, false)
    assert.equal(fs.readFileSync(file, 'utf8'), '{not json')
    assert.equal(codex.uninstall().ok, false)
  } finally { e.restore() }
})

test('install without a hooks.json creates it; uninstall deletes it again (only Hinty hooks in it)', () => {
  const e = envs()
  try {
    const file = path.join(e.codexHome, 'hooks.json')
    assert.equal(codex.install().ok, true)
    assert.ok(fs.existsSync(file) && !fs.existsSync(path.join(e.codexHome, codex.BAK)))
    assert.equal(codex.uninstall().ok, true)
    assert.equal(fs.existsSync(file), false)
    assert.equal(codex.uninstall().ok, true, 'nothing to remove is fine')
  } finally { e.restore() }
})

test('configNotes warns about [hooks] in config.toml and hooks switched off', () => {
  const e = envs()
  try {
    assert.deepEqual(codex.configNotes(), [])
    fs.writeFileSync(path.join(e.codexHome, 'config.toml'), '[features]\nhooks = false\n\n[hooks]\nfoo = 1\n')
    assert.equal(codex.configNotes().length, 2)
    fs.writeFileSync(path.join(e.codexHome, 'config.toml'), '[hooks.state."x"]\ntrusted_hash = "a"\n')
    assert.deepEqual(codex.configNotes(), [], 'trust state alone is not a [hooks] layer')
  } finally { e.restore() }
})

test('normalize: Codex field names (taken from a real run) and bad input', () => {
  const n = codex.normalize({ session_id: SID, turn_id: 't', cwd: 'E:\\x\\proj', hook_event_name: 'Stop', model: 'm', permission_mode: 'default', stop_hook_active: false, last_assistant_message: 'ok' })
  assert.deepEqual(n, { sid: SID, cwd: 'E:\\x\\proj', tool: 'tool', input: undefined, text: 'ok', source: '', stopActive: false, agentId: null, agentType: '', home: '' })
  const p = codex.normalize({ session_id: SID, tool_name: 'Bash', tool_input: { command: 'ls' }, source: 'startup', agent_id: 'a1', agent_type: 'worker' })
  assert.equal(p.tool, 'Bash'); assert.deepEqual(p.input, { command: 'ls' }); assert.equal(p.agentId, 'a1')
  for (const bad of [null, 'x', [], {}, { session_id: 5 }]) assert.equal(codex.normalize(bad), null)
})

// ------------------------------------------------------------------------------------------------
// The hook process
// ------------------------------------------------------------------------------------------------

function runHook(dir, event, input) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint()
    const c = spawn(process.execPath, [HOOK, event], { env: { ...process.env, HINTY_AGENTS_HOME: dir }, windowsHide: true })
    let stdout = ''; let stderr = ''
    c.stdout.on('data', (b) => { stdout += b }); c.stderr.on('data', (b) => { stderr += b })
    c.on('close', (code) => resolve({ code, stdout, stderr, ms: Number(process.hrtime.bigint() - t0) / 1e6 }))
    c.stdin.end(input)
  })
}
const INPUT = JSON.stringify({ session_id: SID, cwd: 'C:\\w\\api', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } })

async function fakeService(dir, routes, secret = 'k'.repeat(43)) {
  const s = createLocalServer({ secret, routes })
  const port = await listenLoopback(s)
  fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ v: 1, pid: process.pid, port, secret }))
  return s
}

test('N1: no service, dead port, bad daemon.json = no output, exit 0, quickly (every event)', async () => {
  const dir = tmp('hinty-hook-')
  for (const ev of ['PermissionRequest', 'Stop', 'PostToolUse', 'UserPromptSubmit', 'SessionEnd', 'Nonsense']) {
    const r = await runHook(dir, ev, INPUT)
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''], ev)
    assert.ok(r.ms < 1500, `${ev} took ${r.ms} ms`)
  }
  fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ v: 1, pid: 1, port: 9, secret: 'x' }))
  assert.equal((await runHook(dir, 'PermissionRequest', INPUT)).stdout, '')
  fs.writeFileSync(path.join(dir, 'daemon.json'), '{not json')
  assert.equal((await runHook(dir, 'Stop', INPUT)).stdout, '')
})

test('N2: PermissionRequest prints only the two fixed answers; Stop prints only {decision:block,reason}', async () => {
  const cases = [
    [{ d: 'allow' }, ALLOW], [{ d: 'allow', updatedInput: { command: 'rm -rf /' }, interrupt: true }, ALLOW],
    [{ d: 'deny', message: 'x' }, DENY], [{}, ''], [{ d: 'ask' }, ''], [{ behavior: 'allow' }, ''], [{ error: 'internal' }, ''],
  ]
  for (const [answer, want] of cases) {
    const dir = tmp('hinty-hook-')
    const s = await fakeService(dir, { 'POST /v1/hook/codex/permission': () => answer })
    const r = await runHook(dir, 'PermissionRequest', INPUT)
    s.close()
    assert.equal(r.code, 0)
    assert.equal(r.stdout, want, JSON.stringify(answer))
  }
  const stops = [[{ cmd: 'run the tests' }, JSON.stringify({ decision: 'block', reason: 'run the tests' })], [{}, ''], [{ cmd: '' }, ''], [{ cmd: 5 }, ''], [{ d: 'allow' }, '']]
  for (const [answer, want] of stops) {
    const dir = tmp('hinty-hook-')
    const s = await fakeService(dir, { 'POST /v1/hook/codex/stop': () => answer })
    const r = await runHook(dir, 'Stop', INPUT)
    s.close()
    assert.equal(r.stdout, want, JSON.stringify(answer))
  }
})

test('an answer without the right proof is ignored (a stranger on the port cannot allow anything)', async () => {
  const dir = tmp('hinty-hook-')
  const http = await import('node:http')
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'x-hinty-proof': 'f'.repeat(64) }); res.end('{"d":"allow"}') })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ v: 1, pid: 1, port: srv.address().port, secret: 'k'.repeat(43) }))
  const r = await runHook(dir, 'PermissionRequest', INPUT)
  srv.close()
  assert.equal(r.stdout, '')
})

test('SessionStart: not paired = silent; paired = the glasses instruction, with or without a running service', async () => {
  const dir = tmp('hinty-hook-')
  let r = await runHook(dir, 'SessionStart', INPUT)
  assert.equal(r.stdout, '')
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ v: 1, api: 'x', bridgeToken: 't'.repeat(40), autostart: false }))
  r = await runHook(dir, 'SessionStart', INPUT)
  const out = JSON.parse(r.stdout)
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.match(out.hookSpecificOutput.additionalContext, /\u{1F453}/u)
})

// ------------------------------------------------------------------------------------------------
// The service's Codex flows
// ------------------------------------------------------------------------------------------------

function fakeRelay(connected = true) { return { connected, sent: [], emit(ev, p) { this.sent.push([ev, p]) } } }
function setup(o = {}) {
  const relay = fakeRelay()
  const svc = new Service({ relay, host: 'h', sessDebounceMs: 0, agents: () => ({ agents: ['claude', 'codex'] }), ...o })
  svc.setAway(true, 'test')
  return { relay, svc }
}
const permInput = (extra = {}) => ({ session_id: SID, turn_id: 't1', cwd: 'E:\\work\\hintyApi', hook_event_name: 'PermissionRequest', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'npm run build' }, ...extra })
const stopInput = (extra = {}) => ({ session_id: SID, turn_id: 't1', cwd: 'E:\\work\\hintyApi', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Fixed it.\n\u{1F453} build fixed, tests pass', ...extra })
const lastPerm = (relay) => relay.sent.filter(([e]) => e === 'perm').at(-1)[1]
const settled = (p, ms = 30) => Promise.race([p.then((v) => ({ v })), sleep(ms).then(() => 'pending')])

test('hello lists the installed agents', () => {
  const { relay, svc } = setup()
  svc.hello()
  assert.deepEqual(relay.sent.find(([e]) => e === 'hello')[1].agents, ['claude', 'codex'])
  svc.stop()
})

test('Codex permission: card with agent codex, allow / deny reach the hook, anything else is empty (N1-N3)', async () => {
  const { relay, svc } = setup()
  const a = svc.codexPermission(permInput())
  const perm = lastPerm(relay)
  assert.equal(perm.tool, 'Bash'); assert.equal(perm.text, 'npm run build')
  const sess = relay.sent.filter(([e]) => e === 'sess').at(-1)[1]
  assert.deepEqual([sess.agent, sess.label, sess.st], ['codex', 'hintyApi', 'perm'])
  // a wrong hash does not decide and keeps waiting (N3)
  svc.onRelay('decide', { rid: perm.rid, d: 'allow', hash: 'x'.repeat(perm.hash.length) })
  assert.equal(await settled(a), 'pending')
  svc.onRelay('decide', { rid: perm.rid, d: 'allow', hash: perm.hash })
  assert.deepEqual(await a, { d: 'allow' })
  const b = svc.codexPermission(permInput({ tool_input: { command: 'rm x' } }))
  svc.onRelay('decide', { rid: lastPerm(relay).rid, d: 'deny', hash: lastPerm(relay).hash })
  assert.deepEqual(await b, { d: 'deny' })
  // N1: bad input / away off / link down
  for (const bad of [null, 'x', {}, permInput({ session_id: 'has space' })]) assert.deepEqual(await svc.codexPermission(bad), {})
  svc.setAway(false, 'test')
  assert.deepEqual(await svc.codexPermission(permInput()), {})
  svc.stop()
})

test('Codex permission: answered in the terminal = the next hook event of the session closes the card (local)', async () => {
  let t = 1000
  const { relay, svc } = setup({ now: () => t })
  const a = svc.codexPermission(permInput())
  t += 50
  svc.agentActivity('codex', { session_id: SID, cwd: 'E:\\work\\hintyApi', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} })
  assert.deepEqual(await a, {})
  assert.equal(relay.sent.filter(([e, p]) => e === 'perm_end' && p.why === 'local').length, 1)
  svc.stop()
})

test('N5: with away mode off a Codex session sends nothing, only hello / away', async () => {
  const relay = fakeRelay()
  const svc = new Service({ relay, host: 'h', sessDebounceMs: 0, agents: () => ({ agents: ['claude', 'codex'] }) })
  svc.agentSessionStart('codex', { session_id: SID, cwd: 'E:\\a\\b', source: 'startup' })
  svc.agentActivity('codex', { session_id: SID, cwd: 'E:\\a\\b' })
  assert.deepEqual(await svc.codexStop(stopInput()), {})
  assert.deepEqual(relay.sent, [])
  assert.equal(svc.status().sessions[0].agent, 'codex')
  svc.stop()
})

test('Codex Stop: state done with the 👓 line; an instruction from the glasses is handed over as the hook answer', async () => {
  const { relay, svc } = setup({ codexStopHoldMs: 5000 })
  svc.agentSessionStart('codex', { session_id: SID, cwd: 'E:\\work\\hintyApi', source: 'startup' })
  const stop = svc.codexStop(stopInput())
  await sleep(20)
  const done = relay.sent.filter(([e]) => e === 'sess').at(-1)[1]
  assert.deepEqual([done.agent, done.st, done.line], ['codex', 'done', 'build fixed, tests pass'])
  assert.equal(await settled(stop), 'pending', 'the hook is held while away mode is on')
  svc.onRelay('say', { sid: SID, text: 'now run the linter' })
  const ans = await stop
  assert.match(ans.cmd, /^Follow-up instruction from the user, sent from their Hinty smart-glasses:\n\nnow run the linter$/)
  await sleep(10)
  assert.equal(relay.sent.filter(([e]) => e === 'sess').at(-1)[1].st, 'run')
  // a command that arrives BEFORE the turn ends is handed over at once
  svc.onRelay('say', { sid: SID, text: 'and commit' })
  assert.match((await svc.codexStop(stopInput({ stop_hook_active: true }))).cmd, /and commit$/)
  // full answer on request
  svc.onRelay('want', { sid: SID, what: 'full' })
  assert.match(relay.sent.filter(([e]) => e === 'msg').at(-1)[1].text, /Fixed it/)
  svc.stop()
})

test('Codex Stop hold ends empty: time up, away off, link lost, hook gone; and the 8-in-a-row limit', async () => {
  let r = setup({ codexStopHoldMs: 40 })
  assert.deepEqual(await r.svc.codexStop(stopInput()), {}); r.svc.stop()

  r = setup({ codexStopHoldMs: 5000 })
  let p = r.svc.codexStop(stopInput()); await sleep(10)
  r.svc.setAway(false, 'x')
  assert.deepEqual(await p, {}); r.svc.stop()

  r = setup({ codexStopHoldMs: 5000 })
  p = r.svc.codexStop(stopInput()); await sleep(10)
  r.relay.connected = false; r.svc.onRelay('disconnect')
  assert.deepEqual(await p, {}); r.svc.stop()

  r = setup({ codexStopHoldMs: 5000 })
  let abort
  p = r.svc.codexStop(stopInput(), { onAbort: (fn) => { abort = fn } }); await sleep(10)
  abort()
  assert.deepEqual(await p, {})
  r.svc.onRelay('say', { sid: SID, text: 'later' })
  assert.match((await r.svc.codexStop(stopInput())).cmd, /later$/, 'the queued instruction waits for the next Stop')
  r.svc.stop()

  r = setup({ codexStopHoldMs: 30 })
  r.svc.agentSessionStart('codex', { session_id: SID, cwd: 'E:\work\hintyApi', source: 'startup' })
  for (let i = 0; i < 8; i++) {
    r.svc.onRelay('say', { sid: SID, text: `c${i}` })
    assert.ok((await r.svc.codexStop(stopInput({ stop_hook_active: i > 0 }))).cmd, `continuation ${i + 1}`)
  }
  r.svc.onRelay('say', { sid: SID, text: 'c9' })
  assert.deepEqual(await r.svc.codexStop(stopInput({ stop_hook_active: true })), {}, 'the ninth in a row is refused')
  assert.ok((await r.svc.codexStop(stopInput({ stop_hook_active: false }))).cmd, 'a fresh user turn resets the count')
  r.svc.stop()
})

test('say with `codex queue`: handed to the queue with the CODEX_HOME of the session; no Stop hold; failure falls back to the hold', async () => {
  const calls = []
  let ok = true
  const { relay, svc } = setup({ codexQueue: async (sid, text, home) => { calls.push([sid, text, home]); return ok }, codexStopHoldMs: 5000 })
  svc.agentSessionStart('codex', { session_id: SID, cwd: 'E:\work\hintyApi', source: 'startup', hinty_codex_home: 'C:\h\.codex' })
  assert.deepEqual(await svc.codexStop(stopInput()), {}, 'with queue available the Stop hook does not hold')
  svc.onRelay('say', { sid: SID, text: '-x --evil "q" & dir' })
  await sleep(10)
  assert.deepEqual(calls, [[SID, '-x --evil "q" & dir', 'C:\h\.codex']])
  assert.equal(svc.cmds.size, 0)
  // queue refuses once: the instruction is kept for a held Stop hook, and holds are on from then
  ok = false
  svc.onRelay('say', { sid: SID, text: 'second' })
  await sleep(10)
  assert.equal(svc.cmds.get(SID).length, 1)
  assert.match((await svc.codexStop(stopInput())).cmd, /second$/)
  // say for an unknown session or with away off never reaches the queue
  svc.onRelay('say', { sid: 'nope', text: 'x' }); svc.setAway(false, 'x'); svc.onRelay('say', { sid: SID, text: 'x' })
  await sleep(10)
  assert.equal(calls.length, 2)
  svc.stop()
})

test('SessionEnd removes the session; a late event does not bring it back', async () => {
  const { relay, svc } = setup()
  svc.agentSessionStart('codex', { session_id: SID, cwd: 'E:\\a\\proj', source: 'startup' })
  svc.agentSessionEnd('codex', { session_id: SID, cwd: 'E:\\a\\proj' })
  await sleep(10)
  assert.equal(relay.sent.filter(([e]) => e === 'sess').at(-1)[1].st, 'end')
  svc.agentActivity('codex', { session_id: SID, cwd: 'E:\\a\\proj' })
  assert.equal(svc.sessions.list().length, 0)
  svc.stop()
})

test('Codex and Claude sessions side by side get their own agent and unique labels', () => {
  const { svc } = setup()
  svc.agentSessionStart('codex', { session_id: SID, cwd: 'E:\\a\\proj', source: 'startup' })
  svc.hookSessionStart({ session_id: 'claude-1', cwd: 'E:\\b\\proj', source: 'startup' })
  const list = svc.sessions.list().map((s) => [s.agent, s.label])
  assert.deepEqual(list, [['codex', 'proj'], ['claude', 'proj-2']])
  svc.stop()
})
