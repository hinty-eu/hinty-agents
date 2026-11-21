// Grok Build adapter (simulated inputs: no live Grok Build is available without a paid xAI account). Format from
// docs.x.ai/build/features/hooks: camelCase stdin, `{"decision":"deny","reason":...}` + exit 2, fail-open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as grok from '../src/adapters/grok.js'
import { activeAgents } from '../src/adapters/index.js'
import { fakeService } from './helpers.js'
import { Service } from '../src/service.js'

const HOOK = fileURLToPath(new URL('../hooks/grok-hook.cjs', import.meta.url))
const SID = 'grok-sess-0001'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

function envs() {
  const grokHome = tmp('hinty-grok-')
  const home = tmp('hinty-home-')
  const saved = [process.env.HINTY_AGENTS_GROK_HOME, process.env.HINTY_AGENTS_HOME, process.env.CODEX_HOME]
  process.env.HINTY_AGENTS_GROK_HOME = grokHome
  process.env.HINTY_AGENTS_HOME = home
  process.env.CODEX_HOME = tmp('hinty-codex-')
  return { grokHome, home, restore() { ['HINTY_AGENTS_GROK_HOME', 'HINTY_AGENTS_HOME', 'CODEX_HOME'].forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i] }) } }
}

test('install writes ~/.grok/hooks/hinty.json: four passive hooks by default, PreToolUse only with --ask-shell', () => {
  const e = envs()
  try {
    assert.equal(grok.install().ok, true)
    const cfg = JSON.parse(fs.readFileSync(path.join(e.grokHome, 'hooks', 'hinty.json'), 'utf8'))
    assert.deepEqual(Object.keys(cfg.hooks).sort(), ['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'])
    assert.deepEqual(grok.installed().askShell, false)
    assert.deepEqual(activeAgents(), ['claude', 'grok'])
    const r = grok.install({ askShell: true })
    assert.ok(r.steps.some((s) => s.step === 'WARNING' && /fails OPEN/.test(s.message)), 'the fail-open warning is part of the install output')
    const cfg2 = JSON.parse(fs.readFileSync(path.join(e.grokHome, 'hooks', 'hinty.json'), 'utf8'))
    const pre = cfg2.hooks.PreToolUse[0]
    assert.match(pre.matcher, /Bash/)
    assert.equal(pre.hooks[0].timeout, grok.ASK_HOLD_S + 20, 'timeout raised from the 5 s default')
    assert.match(pre.hooks[0].command, new RegExp(` PreToolUse ${grok.ASK_HOLD_S}$`))
    assert.equal(grok.installed().askShell, true)
    assert.equal(grok.uninstall().ok, true)
    assert.equal(fs.existsSync(path.join(e.grokHome, 'hooks', 'hinty.json')), false)
    assert.deepEqual(activeAgents(), ['claude'])
  } finally { e.restore() }
})

test('a hinty.json that is not ours is backed up on install, restored on uninstall, never deleted', () => {
  const e = envs()
  try {
    const file = path.join(e.grokHome, 'hooks', 'hinty.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"hooks":{"PreToolUse":[]}}')
    grok.install()
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '{"hooks":{"PreToolUse":[]}}')
    grok.uninstall()
    assert.equal(fs.readFileSync(file, 'utf8'), '{"hooks":{"PreToolUse":[]}}')
    assert.equal(grok.uninstall().ok, false, 'now it is not ours: refused')
    assert.equal(fs.existsSync(file), true)
  } finally { e.restore() }
})

test('normalize: camelCase input from the docs', () => {
  const n = grok.normalize({ hookEventName: 'PreToolUse', sessionId: SID, cwd: '/w/p', workspaceRoot: '/w/p', toolName: 'Bash', toolInput: { command: 'ls' } })
  assert.deepEqual([n.sid, n.cwd, n.tool, n.input], [SID, '/w/p', 'Bash', { command: 'ls' }])
  assert.equal(grok.normalize({ hookEventName: 'Stop', sessionId: SID, lastAssistantMessage: 'done' }).text, 'done')
  for (const bad of [null, 'x', [], {}, { sessionId: 3 }]) assert.equal(grok.normalize(bad), null)
})

test('isExcepted: harmless commands skip the card, chains and tricks do not', () => {
  // since the security review (point 9) chains are never excepted: `pwd && ls` and `cat a.txt | head -5` get a card
  const ok = ['ls', 'ls -la', 'git status', 'git diff HEAD~1', 'echo hi', 'cat src/a.txt', 'git log --oneline -5']
  const no = ['', 'rm -rf x', 'ls; rm x', 'ls && rm x', 'echo $(rm x)', 'echo `id`', 'cat a > b', 'lsof', 'git push', 'ls\nrm x', 'git statusx', 'echo ${HOME}', 'ls ||', 'cat <(id)',
    'pwd && ls', 'cat a.txt | head -5', 'ls & rm -rf x', 'ls &', 'git diff --output=/tmp/x', 'git log -o x', 'git diff --ext-diff',
    'npm test', 'npm run test', 'git branch -D main', 'cat /etc/passwd', 'cat ../x', 'cat ~/.hinty-agents/config.json',
    'head C:\\Users\\me\\.ssh\\id_rsa', 'tail src/../../x', 'ls\u0007', 'echo "a"']
  for (const c of ok) assert.equal(grok.isExcepted(c), true, c)
  for (const c of no) assert.equal(grok.isExcepted(c), false, JSON.stringify(c))
  assert.equal(grok.isExcepted('make test', ['make test']), true, 'own list')
})

test('isShellTool', () => {
  for (const t of ['Bash', 'bash', 'PowerShell', 'shell', 'run_terminal_cmd']) assert.equal(grok.isShellTool(t), true, t)
  for (const t of ['Read', 'Edit', 'WebFetch', 'bashful', '']) assert.equal(grok.isShellTool(t), false, t)
})

// ------------------------------------------------------------------------------------------------
// The hook process and the service
// ------------------------------------------------------------------------------------------------

function runHook(dir, args, input) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint()
    const c = spawn(process.execPath, [HOOK, ...args], { env: { ...process.env, HINTY_AGENTS_HOME: dir }, windowsHide: true })
    let stdout = ''; let stderr = ''
    c.stdout.on('data', (b) => { stdout += b }); c.stderr.on('data', (b) => { stderr += b })
    c.on('close', (code) => resolve({ code, stdout, stderr, ms: Number(process.hrtime.bigint() - t0) / 1e6 }))
    c.stdin.end(input)
  })
}
const PRE = JSON.stringify({ hookEventName: 'PreToolUse', sessionId: SID, cwd: '/w/p', toolName: 'Bash', toolInput: { command: 'rm -rf build' } })

test('N1: no service = no output, exit 0 (Grok then runs the step: fail-open is Grok\'s rule), every event, fast', async () => {
  const dir = tmp('hinty-hook-')
  for (const ev of ['PreToolUse', 'Stop', 'SessionStart', 'UserPromptSubmit', 'SessionEnd']) {
    const r = await runHook(dir, [ev, '280'], PRE)
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''], ev)
    assert.ok(r.ms < 1500, `${ev} ${r.ms} ms`)
  }
})

test('PreToolUse prints a veto only for {d:"deny"}: JSON on stdout, reason on stderr, exit 2', async () => {
  for (const [answer, veto] of [[{ d: 'deny' }, true], [{ d: 'allow' }, false], [{}, false], [{ d: 'maybe' }, false]]) {
    const dir = tmp('hinty-hook-')
    const s = await fakeService(dir, { 'POST /v1/hook/grok/pre-tool': () => answer })
    const r = await runHook(dir, ['PreToolUse', '280'], PRE)
    s.close()
    if (veto) assert.deepEqual([r.code, r.stdout, r.stderr], [2, '{"decision":"deny","reason":"Denied from Hinty glasses"}', 'Denied from Hinty glasses'])
    else assert.deepEqual([r.code, r.stdout], [0, ''])
  }
})

function setup(o = {}) {
  const relay = { connected: true, sent: [], emit(ev, p) { this.sent.push([ev, p]) } }
  const svc = new Service({ relay, host: 'h', sessDebounceMs: 0, agents: () => ({ agents: ['claude', 'grok'], grok: { askShell: true, except: grok.DEFAULT_EXCEPT } }), ...o })
  svc.setAway(true, 'test')
  return { relay, svc }
}
const pre = (command, extra = {}) => ({ hookEventName: 'PreToolUse', sessionId: SID, cwd: 'E:\\w\\site', toolName: 'Bash', toolInput: { command }, ...extra })
const lastPerm = (relay) => relay.sent.filter(([e]) => e === 'perm').at(-1)[1]

test('ask-shell: a card for a risky command, deny = veto, allow = no veto, exceptions and other tools get none', async () => {
  const { relay, svc } = setup()
  assert.deepEqual(await svc.grokPreTool(pre('git status')), {}, 'exception: no card')
  assert.deepEqual(await svc.grokPreTool(pre('x', { toolName: 'Read' })), {}, 'not a shell tool')
  assert.equal(relay.sent.filter(([e]) => e === 'perm').length, 0)
  const a = svc.grokPreTool(pre('rm -rf build'))
  const perm = lastPerm(relay)
  assert.equal(perm.text, 'rm -rf build')
  assert.equal(relay.sent.filter(([e]) => e === 'sess').at(-1)[1].agent, 'grok')
  svc.onRelay('decide', { rid: perm.rid, d: 'deny', hash: perm.hash })
  assert.deepEqual(await a, { d: 'deny' })
  const b = svc.grokPreTool(pre('npm publish'))
  svc.onRelay('decide', { rid: lastPerm(relay).rid, d: 'allow', hash: lastPerm(relay).hash })
  assert.deepEqual(await b, { d: 'allow' }, 'the hook prints nothing for allow')
  svc.stop()
})

test('ask-shell off, away off, link down: no card, empty answer at once (N1/N5)', async () => {
  let r = setup({ agents: () => ({ agents: ['claude', 'grok'], grok: { askShell: false, except: [] } }) })
  assert.deepEqual(await r.svc.grokPreTool(pre('rm -rf x')), {}); r.svc.stop()
  r = setup(); r.svc.setAway(false, 'x')
  assert.deepEqual(await r.svc.grokPreTool(pre('rm -rf x')), {}); r.svc.stop()
  r = setup(); r.relay.connected = false
  assert.deepEqual(await r.svc.grokPreTool(pre('rm -rf x')), {}); r.svc.stop()
})

test('ask-shell: time up = empty answer (the step runs, as Grok does with any failing hook)', async () => {
  const { relay, svc } = setup({ grokPermTtlMs: 40 })
  assert.deepEqual(await svc.grokPreTool(pre('rm -rf x')), {})
  assert.equal(relay.sent.filter(([e, p]) => e === 'perm_end' && p.why === 'timeout').length, 1)
  svc.stop()
})

test('Grok state: session, turn, stop with a line; say to a Grok session is refused (unsupported)', async () => {
  const { relay, svc } = setup()
  svc.agentSessionStart('grok', { hookEventName: 'SessionStart', sessionId: SID, cwd: 'E:\\w\\site' })
  svc.agentActivity('grok', { hookEventName: 'UserPromptSubmit', sessionId: SID, cwd: 'E:\\w\\site' })
  await sleep(10)
  assert.equal(relay.sent.filter(([e]) => e === 'sess').at(-1)[1].st, 'run')
  svc.agentStop('grok', { hookEventName: 'Stop', sessionId: SID, cwd: 'E:\\w\\site', lastAssistantMessage: 'Deployed.' })
  await sleep(10)
  assert.deepEqual(relay.sent.filter(([e]) => e === 'sess').at(-1)[1].st, 'done')
  svc.onRelay('say', { sid: SID, text: 'do more' })
  assert.equal(svc.cmds.size, 0, 'nothing is queued for Grok')
  svc.agentSessionEnd('grok', { hookEventName: 'SessionEnd', sessionId: SID })
  assert.equal(svc.sessions.list().length, 0)
  svc.stop()
})
