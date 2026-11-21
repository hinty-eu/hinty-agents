// The stable copy of the program (src/app.js): npx runs from a cache folder npm may clean, so setup / start / install copy
// the package to <data folder>/app/<version> and everything (service entry, hook files, plugin marketplace) uses that.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appBase, copyPackage, ensureApp, findDependency, isDevCheckout, pruneOld } from '../src/app.js'
import { packageRoot, setActiveRoot } from '../src/root.js'
import { cliEntry } from '../src/store.js'
import * as claude from '../src/adapters/claude.js'

const REPO = fileURLToPath(new URL('../', import.meta.url))
const CLI = path.join(REPO, 'bin', 'hinty-agents.js')
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hinty-app-'))

/** run a body with HINTY_AGENTS_HOME / HINTY_AGENTS_DEV set; the active root goes back afterwards */
function withHome(home, dev, body) {
  const saved = { h: process.env.HINTY_AGENTS_HOME, d: process.env.HINTY_AGENTS_DEV }
  process.env.HINTY_AGENTS_HOME = home
  process.env.HINTY_AGENTS_DEV = dev
  try { return body() } finally {
    setActiveRoot(null)
    for (const [k, v] of [['HINTY_AGENTS_HOME', saved.h], ['HINTY_AGENTS_DEV', saved.d]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

test('ensureApp copies the package and its dependencies to app/<version> and switches to it', () => {
  const home = tmp()
  withHome(home, '0', () => {
    const r = ensureApp()
    const target = path.join(home, 'app', VERSION)
    assert.equal(r.copied, true)
    assert.equal(r.root, target)
    assert.equal(cliEntry(), path.join(target, 'bin', 'hinty-agents.js'))
    assert.equal(claude.repoRoot(), target, 'the plugin marketplace is added from the copy')
    for (const f of ['package.json', 'bin/hinty-agents.js', 'src/cli.js', 'claude-plugin/hook.cjs', 'hooks/common.cjs', 'hermes-plugin/hinty-agents/__init__.py', '.claude-plugin/marketplace.json', 'node_modules/socket.io-client/package.json', 'node_modules/ws/package.json']) {
      assert.equal(fs.existsSync(path.join(target, f)), true, f)
    }
    assert.equal(fs.existsSync(path.join(target, 'test')), false, 'no tests in the copy')
    assert.equal(fs.existsSync(path.join(target, '.git')), false)
    assert.deepEqual(fs.readdirSync(path.join(home, 'app')), [VERSION], 'no temporary folder left')
    // the copy runs on its own: Node resolves socket.io-client from the copy's node_modules
    const v = spawnSync(process.execPath, [cliEntry(), '--version'], { encoding: 'utf8', env: { ...process.env, HINTY_AGENTS_HOME: home } })
    assert.equal(v.stdout.trim(), VERSION, v.stderr)
    // a second call finds the finished copy
    setActiveRoot(null)
    assert.equal(ensureApp().copied, false)
  })
})

test('a development checkout (.git or HINTY_AGENTS_DEV=1) runs in place; npm folders never count as one', () => {
  const home = tmp()
  withHome(home, '1', () => {
    const r = ensureApp()
    assert.equal(r.dev, true)
    assert.equal(r.root, packageRoot())
    assert.equal(fs.existsSync(path.join(home, 'app')), false)
  })
  const d = tmp()
  assert.equal(isDevCheckout(d), false)
  fs.mkdirSync(path.join(d, '.git'))
  const saved = process.env.HINTY_AGENTS_DEV
  delete process.env.HINTY_AGENTS_DEV
  try {
    assert.equal(isDevCheckout(d), true)
    const nm = path.join(d, 'node_modules', 'hinty-agents')
    fs.mkdirSync(path.join(nm, '.git'), { recursive: true })
    assert.equal(isDevCheckout(nm), false, 'a .git inside node_modules is not a checkout of ours')
  } finally { if (saved !== undefined) process.env.HINTY_AGENTS_DEV = saved }
})

test('running from the copy itself changes nothing', () => {
  const home = tmp()
  withHome(home, '0', () => {
    const first = ensureApp()
    setActiveRoot(null)
    const again = ensureApp({ srcRoot: first.root })
    assert.equal(again.copied, false)
    assert.equal(again.root, first.root)
  })
})

test('a broken copy (no dependencies) is replaced atomically, not trusted', () => {
  const home = tmp()
  withHome(home, '0', () => {
    const target = path.join(home, 'app', VERSION)
    fs.mkdirSync(path.join(target, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'hinty-agents', version: VERSION }))
    fs.writeFileSync(path.join(target, 'bin', 'hinty-agents.js'), '// half a copy')
    const r = ensureApp()
    assert.equal(r.copied, true)
    assert.equal(fs.existsSync(path.join(target, 'node_modules', 'socket.io-client', 'package.json')), true)
    assert.deepEqual(fs.readdirSync(path.join(home, 'app')), [VERSION], 'the half copy is gone too')
  })
})

test('old versions are removed after the switch: the current and the newest other one stay', () => {
  const home = tmp()
  withHome(home, '0', () => {
    for (const v of ['0.1.0', '0.2.0', '0.2.5', '.tmp-123-x']) fs.mkdirSync(path.join(home, 'app', v), { recursive: true })
    const r = ensureApp()
    assert.deepEqual(fs.readdirSync(appBase()).sort(), ['0.2.5', VERSION].sort())
    assert.deepEqual(r.removed.sort(), ['.tmp-123-x', '0.1.0', '0.2.0'].sort())
    assert.deepEqual(pruneOld(VERSION), [], 'nothing more to remove')
  })
})

test('a dependency is looked up like Node does (nearest node_modules up the tree) and nested when versions clash', () => {
  const root = tmp()
  const mk = (dir, name, version, deps = {}) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, dependencies: deps }))
  }
  const pkg = path.join(root, 'node_modules', 'hinty-agents')
  mk(pkg, 'hinty-agents', '1.0.0', { a: '*', b: '*' })
  mk(path.join(root, 'node_modules', 'a'), 'a', '1.0.0', { c: '*' })
  mk(path.join(root, 'node_modules', 'b'), 'b', '1.0.0', { c: '*' })
  mk(path.join(root, 'node_modules', 'c'), 'c', '1.0.0')
  mk(path.join(root, 'node_modules', 'b', 'node_modules', 'c'), 'c', '2.0.0')
  assert.equal(findDependency(pkg, 'a'), path.join(root, 'node_modules', 'a'))
  assert.equal(findDependency(path.join(root, 'node_modules', 'b'), 'c'), path.join(root, 'node_modules', 'b', 'node_modules', 'c'))
  assert.equal(findDependency(pkg, 'nope'), null)
  const dest = path.join(tmp(), 'out')
  copyPackage(pkg, dest)
  const ver = (p) => JSON.parse(fs.readFileSync(path.join(dest, p, 'package.json'), 'utf8')).version
  assert.equal(ver('node_modules/a'), '1.0.0')
  assert.equal(ver('node_modules/c'), '1.0.0', 'the first c takes the top level (the one a needs)')
  assert.equal(ver('node_modules/b/node_modules/c'), '2.0.0', 'b keeps its own c')
})

test('start copies the program first; uninstall --all removes the copy and keeps or deletes the data', () => {
  const home = tmp()
  const user = tmp()
  const env = { ...process.env, HINTY_AGENTS_HOME: home, HINTY_AGENTS_DEV: '0', HOME: user, USERPROFILE: user, CLAUDE_CONFIG_DIR: path.join(user, '.claude'), CODEX_HOME: path.join(user, '.codex'), HERMES_HOME: path.join(user, '.hermes'), HINTY_AGENTS_NO_NOTIFY: '1', NO_COLOR: '1', DISABLE_AUTOUPDATER: '1' }
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 90000, windowsHide: true, input: '' })
  let r = cli('start')
  assert.match(r.stdout, /Program copied to/, r.stdout + r.stderr)
  assert.match(r.stdout, /Not paired/)
  assert.equal(fs.existsSync(path.join(home, 'app', VERSION, 'bin', 'hinty-agents.js')), true)
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 1, api: 'http://127.0.0.1:9' }))
  r = cli('uninstall', '--all', '--keep-data')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(fs.existsSync(path.join(home, 'app')), false, 'the program copy is gone')
  assert.equal(fs.existsSync(path.join(home, 'config.json')), true, 'the data stays with --keep-data')
  // no terminal and no flag: data is kept, and says so
  cli('start')
  r = cli('uninstall', '--all')
  assert.match(r.stdout, /is kept/)
  assert.equal(fs.existsSync(path.join(home, 'config.json')), true)
  // --purge deletes the whole folder
  r = cli('uninstall', '--all', '--purge')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(fs.existsSync(home), false)
})
