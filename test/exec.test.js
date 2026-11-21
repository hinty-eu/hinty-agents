// Security review point 6: programs are never taken from the current folder, never started through a shell; npm shims
// are mapped to what they start; overrides must be absolute.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { hardenEnv, isAbsPath, isOurDaemonLine, parseShim, processCommandLine, resolveProgram, which } from '../src/exec.js'

const WIN = process.platform === 'win32'
const CLI = fileURLToPath(new URL('../bin/hinty-agents.js', import.meta.url))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hinty-exec-'))

test('which(): empty and relative PATH entries (= the current folder) are skipped', () => {
  const evil = tmp()
  const good = tmp()
  const name = 'hintyfaketool'
  const ext = WIN ? '.exe' : ''
  fs.writeFileSync(path.join(evil, name + ext), 'x')
  fs.writeFileSync(path.join(good, name + ext), 'x')
  if (!WIN) { fs.chmodSync(path.join(evil, name), 0o755); fs.chmodSync(path.join(good, name), 0o755) }
  const cwd = process.cwd()
  process.chdir(evil)
  try {
    assert.equal(which(name, { path: ['', '.', 'sub', good].join(path.delimiter) }), path.join(good, name + ext))
    assert.equal(which(name, { path: ['', '.'].join(path.delimiter) }), null)
    assert.equal(which('../x'), null, 'no path parts in the name')
  } finally { process.chdir(cwd) }
})

test('isAbsPath: drive and UNC paths on Windows, / elsewhere; C:foo, \\foo, relative = no', () => {
  if (WIN) {
    for (const p of ['C:\\x', 'c:/x', '\\\\srv\\share\\x']) assert.equal(isAbsPath(p), true, p)
    for (const p of ['C:x', '\\x', '/x', 'x', '.h', '']) assert.equal(isAbsPath(p), false, p)
  } else {
    assert.equal(isAbsPath('/x'), true)
    for (const p of ['x', './x', '.h', '']) assert.equal(isAbsPath(p), false, p)
  }
})

test('npm shims are read, not run through cmd.exe: exe target, node + script, npm.cmd variables', () => {
  const dir = tmp()
  fs.mkdirSync(path.join(dir, 'node_modules', 'a', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', 'a', 'bin', 'a.exe'), 'x')
  fs.writeFileSync(path.join(dir, 'node_modules', 'a', 'cli.mjs'), 'x')
  const shim = path.join(dir, 'a.cmd')
  assert.deepEqual(parseShim(shim, '@ECHO off\r\n"%dp0%\\node_modules\\a\\bin\\a.exe"   %*\r\n'), { cmd: path.join(dir, 'node_modules', 'a', 'bin', 'a.exe'), prefix: [] })
  assert.deepEqual(parseShim(shim, 'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\a\\cli.mjs" %*\r\n'),
    { cmd: process.execPath, prefix: [path.join(dir, 'node_modules', 'a', 'cli.mjs')] })
  assert.deepEqual(parseShim(shim, 'SET "NODE_EXE=%~dp0\\node.exe"\r\nSET "NPM_CLI_JS=%~dp0\\node_modules\\a\\cli.mjs"\r\n"%NODE_EXE%" "%NPM_CLI_JS%" %*\r\n'),
    { cmd: process.execPath, prefix: [path.join(dir, 'node_modules', 'a', 'cli.mjs')] })
  assert.equal(parseShim(shim, 'echo nothing here %*'), null)
})

test('overrides (HINTY_AGENTS_GROK and the like) must be absolute; a relative one is ignored, never resolved', () => {
  const dir = tmp()
  const js = path.join(dir, 'fake.mjs')
  fs.writeFileSync(js, 'console.log("1.0.0")')
  assert.deepEqual(resolveProgram('nothing-here', js), { cmd: process.execPath, prefix: [js] })
  assert.equal(resolveProgram('nothing-here', 'fake.mjs'), null)
  assert.equal(resolveProgram('nothing-here', path.join(dir, 'missing.exe')), null)
})

test('hardenEnv sets NoDefaultCurrentDirectoryInExePath on Windows', { skip: WIN ? false : 'Windows only' }, () => {
  const before = process.env.NoDefaultCurrentDirectoryInExePath
  delete process.env.NoDefaultCurrentDirectoryInExePath
  hardenEnv()
  assert.equal(process.env.NoDefaultCurrentDirectoryInExePath, '1')
  if (before === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath
  else process.env.NoDefaultCurrentDirectoryInExePath = before
})

test('a planted claude.cmd / grok.cmd / npm.cmd in the current folder is not run by `doctor` (end to end)', { skip: WIN ? false : 'Windows only' }, () => {
  const repo = tmp()
  const home = tmp()
  const marker = path.join(repo, 'PWNED.txt')
  for (const n of ['claude', 'grok', 'npm', 'hermes', 'openclaw', 'codex', 'icacls', 'taskkill']) {
    fs.writeFileSync(path.join(repo, `${n}.cmd`), `@echo off\r\necho %~n0>> "${marker}"\r\n`)
  }
  const env = { ...process.env, HINTY_AGENTS_HOME: path.join(home, 'h') }
  delete env.NoDefaultCurrentDirectoryInExePath
  const r = spawnSync(process.execPath, [CLI, 'doctor'], { cwd: repo, env, encoding: 'utf8', timeout: 120000, windowsHide: true })
  assert.notEqual(r.status, null, 'doctor finished')
  assert.equal(fs.existsSync(marker), false, fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '')
})

test('our service is recognised by its command line', () => {
  assert.equal(isOurDaemonLine('"C:\\Program Files\\nodejs\\node.exe" C:\\x\\hinty-agents\\bin\\hinty-agents.js daemon'), true)
  assert.equal(isOurDaemonLine('node /usr/lib/node_modules/hinty-agents/bin/hinty-agents.js daemon'), true)
  assert.equal(isOurDaemonLine('node server.js'), false)
  assert.equal(isOurDaemonLine('node hinty-agents.js daemonx'), false)
  assert.equal(isOurDaemonLine(null), false)
  const own = processCommandLine(process.pid)
  assert.ok(own && /node/i.test(own), String(own))
})
