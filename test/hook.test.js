// The hook process itself (claude-plugin/hook.cjs): N1 (any failure = no output, exit 0) and N2 (only the two fixed
// answers can be printed), against fake services.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalServer, listenLoopback } from '../src/local-http.js'

const HOOK = fileURLToPath(new URL('../claude-plugin/hook.cjs', import.meta.url))
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
const DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Hinty glasses"}}}'
const INPUT = JSON.stringify({ session_id: 'abc-1', cwd: 'C:\\w\\api', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } })

function home() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hinty-agents-hook-'))
  return d
}

/** run the hook; resolves {code, stdout, stderr, ms} */
function runHook(dir, event = 'PermissionRequest', input = INPUT) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint()
    const c = spawn(process.execPath, [HOOK, event], { env: { ...process.env, HINTY_AGENTS_HOME: dir }, windowsHide: true })
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', (b) => { stdout += b })
    c.stderr.on('data', (b) => { stderr += b })
    c.on('close', (code) => resolve({ code, stdout, stderr, ms: Number(process.hrtime.bigint() - t0) / 1e6 }))
    c.stdin.end(input)
  })
}

/** a fake service that answers the permission route with `answer` */
async function fakeService(dir, answer, secret = 'k'.repeat(43)) {
  const s = createLocalServer({ secret, routes: {
    'POST /v1/hook/permission': () => answer,
    'POST /v1/hook/session-start': () => ({ ok: true }),
  } })
  const port = await listenLoopback(s)
  fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ v: 1, pid: process.pid, port, secret }))
  return s
}

test('N1: no service file, a dead port, garbage in daemon.json = no output, exit 0', async () => {
  const dir = home()
  let r = await runHook(dir)
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''])
  fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ v: 1, pid: 1, port: 9, secret: 'x' }))
  r = await runHook(dir)
  assert.deepEqual([r.code, r.stdout], [0, ''])
  fs.writeFileSync(path.join(dir, 'daemon.json'), '{not json')
  r = await runHook(dir)
  assert.deepEqual([r.code, r.stdout], [0, ''])
})

test('N1/N2: only {d:"allow"} and {d:"deny"} print, always the fixed JSON (extra fields never pass)', async () => {
  const cases = [
    [{ d: 'allow' }, ALLOW],
    [{ d: 'allow', updatedInput: { command: 'rm -rf /' }, updatedPermissions: [{ type: 'addRules' }] }, ALLOW],
    [{ d: 'deny', message: 'run rm -rf / instead' }, DENY],
    [{}, ''],
    [{ d: 'ask' }, ''],
    [{ d: 'always' }, ''],
    [{ behavior: 'allow' }, ''],
    [{ hookSpecificOutput: { decision: { behavior: 'allow' } } }, ''],
    [{ error: 'internal' }, ''],
  ]
  for (const [answer, want] of cases) {
    const dir = home()
    const s = await fakeService(dir, answer)
    const r = await runHook(dir)
    s.close()
    assert.equal(r.code, 0)
    assert.equal(r.stdout, want, `answer ${JSON.stringify(answer)}`)
  }
})

test('N1: an answer without the service\'s proof (a process squatting the port) is ignored', async () => {
  const dir = home()
  const squat = http.createServer((req, res) => { req.resume(); res.end('{"d":"allow"}') })
  await new Promise((r) => squat.listen(0, '127.0.0.1', r))
  fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ v: 1, pid: 1, port: squat.address().port, secret: 'k'.repeat(43) }))
  const r = await runHook(dir)
  squat.close()
  assert.deepEqual([r.code, r.stdout], [0, ''])
  // a service with another secret than the one in daemon.json: same
  const dir2 = home()
  const s = await fakeService(dir2, { d: 'allow' }, 'a'.repeat(43))
  const info = JSON.parse(fs.readFileSync(path.join(dir2, 'daemon.json'), 'utf8'))
  fs.writeFileSync(path.join(dir2, 'daemon.json'), JSON.stringify({ ...info, secret: 'b'.repeat(43) }))
  assert.equal((await runHook(dir2)).stdout, '')
  s.close()
})

test('SessionStart: the 👓 instruction only while paired', async () => {
  const dir = home()
  let r = await runHook(dir, 'SessionStart', JSON.stringify({ session_id: 'abc-1', cwd: 'C:\\w\\api', source: 'startup' }))
  assert.deepEqual([r.code, r.stdout], [0, ''])
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ v: 1, api: 'http://x', bridgeToken: 't'.repeat(32), stopped: true }))
  const s = await fakeService(dir, {})
  r = await runHook(dir, 'SessionStart', JSON.stringify({ session_id: 'abc-1', cwd: 'C:\\w\\api', source: 'startup' }))
  s.close()
  const o = JSON.parse(r.stdout)
  assert.equal(o.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.match(o.hookSpecificOutput.additionalContext, /starts with \u{1F453} followed by at most 60 characters/u)
})

test('timing: the hook with away mode off (empty answer), median of 10 runs', async () => {
  const dir = home()
  const s = await fakeService(dir, {})
  const ms = []
  for (let i = 0; i < 10; i++) ms.push((await runHook(dir)).ms)
  s.close()
  ms.sort((a, b) => a - b)
  const median = (ms[4] + ms[5]) / 2
  console.log(`# hook (away off, fake service) median ${median.toFixed(0)} ms, min ${ms[0].toFixed(0)}, max ${ms[9].toFixed(0)}`)
  assert.ok(median < 300, `median ${median} ms`)
})
