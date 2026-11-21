// Security review point 8: HINTY_AGENTS_HOME counts only as an absolute path (a relative one would point into the
// project the agent works in), and the hooks start the service only from an installed hinty-agents outside the
// session's own project folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { homeDir } from '../src/store.js'

const require = createRequire(import.meta.url)
const common = require('../hooks/common.cjs')
const HOOK = fileURLToPath(new URL('../claude-plugin/hook.cjs', import.meta.url))
const CODEX_HOOK = fileURLToPath(new URL('../hooks/codex-hook.cjs', import.meta.url))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hinty-home-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** a fake "hinty-agents" install whose `daemon` only writes a marker file */
function fakeInstall(dir, marker) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'hinty-agents', version: '9.9.9' }))
  const entry = path.join(dir, 'bin', 'hinty-agents.js')
  fs.writeFileSync(entry, `require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '))`)
  return entry
}

function run(file, event, input, { cwd, env }) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [file, event], { cwd, env, windowsHide: true })
    let stdout = ''
    c.stdout.on('data', (b) => { stdout += b })
    c.on('close', (code) => resolve({ code, stdout }))
    c.stdin.end(input)
  })
}

/** environment with a fake user home, so the default ~/.hinty-agents is a test folder too */
const isolated = (userHome, extra) => ({ ...process.env, USERPROFILE: userHome, HOME: userHome, ...extra })

test('a relative HINTY_AGENTS_HOME is ignored: the project\'s .h/config.json is never read, its entry never run', async () => {
  const repo = tmp()
  const userHome = tmp()
  const marker = path.join(repo, 'PWNED.txt')
  const entry = fakeInstall(path.join(repo, 'evil'), marker)
  fs.mkdirSync(path.join(repo, '.h'))
  fs.writeFileSync(path.join(repo, '.h', 'config.json'), JSON.stringify({ v: 1, api: 'x', bridgeToken: 't'.repeat(32), entry }))
  const input = JSON.stringify({ session_id: 's-1', cwd: repo, source: 'startup' })
  for (const hook of [HOOK, CODEX_HOOK]) {
    const r = await run(hook, 'SessionStart', input, { cwd: repo, env: isolated(userHome, { HINTY_AGENTS_HOME: '.h' }) })
    assert.equal(r.stdout, '', 'not paired in the real (default) folder: nothing printed')
  }
  await sleep(500)
  assert.equal(fs.existsSync(marker), false)
  // the CLI side ignores it as well
  const before = process.env.HINTY_AGENTS_HOME
  process.env.HINTY_AGENTS_HOME = '.h'
  try { assert.equal(path.isAbsolute(homeDir()), true); assert.notEqual(homeDir(), '.h') } finally { process.env.HINTY_AGENTS_HOME = before }
})

test('autostart runs only an installed hinty-agents outside the session\'s project folder', async () => {
  const repo = tmp()
  const home = tmp()
  const userHome = tmp()
  const inRepo = path.join(repo, 'PWNED.txt')
  const outside = path.join(home, 'STARTED.txt')
  const evil = fakeInstall(path.join(repo, 'node_modules', 'hinty-agents'), inRepo)
  const input = JSON.stringify({ session_id: 's-1', cwd: repo, source: 'startup' })
  const env = isolated(userHome, { HINTY_AGENTS_HOME: home })
  // (a) an entry inside the project the agent works in
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 1, api: 'x', bridgeToken: 't'.repeat(32), entry: evil }))
  let r = await run(CODEX_HOOK, 'SessionStart', input, { cwd: repo, env })
  assert.match(r.stdout, /SessionStart/, 'still paired: the glasses instruction is added')
  // (b) a file that is not a hinty-agents install, and a relative entry
  const other = path.join(home, 'x.js')
  fs.writeFileSync(other, `require('fs').writeFileSync(${JSON.stringify(inRepo)}, 'x')`)
  for (const entry of [other, 'bin/hinty-agents.js']) {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 1, api: 'x', bridgeToken: 't'.repeat(32), entry }))
    r = await run(CODEX_HOOK, 'SessionStart', input, { cwd: repo, env })
  }
  await sleep(600)
  assert.equal(fs.existsSync(inRepo), false, 'nothing from the project or a foreign file was started')
  // (c) a real install elsewhere is started (autostart after a reboot still works)
  const good = fakeInstall(path.join(home, 'pkg'), outside)
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 1, api: 'x', bridgeToken: 't'.repeat(32), entry: good }))
  r = await run(CODEX_HOOK, 'SessionStart', input, { cwd: repo, env })
  for (let i = 0; i < 30 && !fs.existsSync(outside); i++) await sleep(100)
  assert.equal(fs.readFileSync(outside, 'utf8'), 'daemon')
  // the pure check
  assert.equal(common.validEntry(good, repo), true)
  assert.equal(common.validEntry(evil, repo), false)
  assert.equal(common.validEntry('bin/hinty-agents.js', repo), false)
})
