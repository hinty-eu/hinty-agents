// Security review 4 (docs/podpowiedzi/PRZEGLAD-bezpieczenstwa-hinty-agents.md, "Przegląd 4"), fixed in 0.3.2:
//   A1  the marker is written only for a folder that did not exist or was empty; it lists the entries WE created, and
//       `uninstall --all --purge` removes only those (and of a sub-folder only our own files)
//   A3  HINTY_AGENTS_HOME with a part that ends in a space, a tab or a dot is refused (default folder + warning)
//   A4  OpenClaw's clean-up copy runs in one pass: 8000 characters in a few milliseconds, the same result as the expressions
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatMessage, openclawStrip } from '../src/adapters/openclaw.js'
import { sayText } from '../src/text.js'
import { appBase, removeProgramCopies } from '../src/app.js'
import { setActiveRoot } from '../src/root.js'
import { HOME_MARKER, badPathPart, ensureHome, homeDir, noteCreated, purgeBlocker, purgeHome } from '../src/store.js'
import { installScripts } from '../src/adapters/hookfiles.js'
import { MODELS } from '../src/stt/models.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI = path.join(ROOT, 'bin', 'hinty-agents.js')
const tmp = (p = 'hinty-r4-') => fs.mkdtempSync(path.join(os.tmpdir(), p))
const write = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

function withHome(home, body) {
  const saved = process.env.HINTY_AGENTS_HOME
  process.env.HINTY_AGENTS_HOME = home
  const restore = () => { setActiveRoot(null); if (saved === undefined) delete process.env.HINTY_AGENTS_HOME; else process.env.HINTY_AGENTS_HOME = saved }
  try { return body() } finally { restore() }
}

// ================================================================ A1

/** the folder of review 4 (S4): somebody else's folder `ai` that holds models, an app and hooks of its own */
function foreignFolder() {
  const ai = path.join(tmp(), 'ai')
  write(path.join(ai, 'models', 'llama-3-70b.gguf'), 'llama')
  write(path.join(ai, 'models', 'sdxl', 'unet.safetensors'), 'sdxl')
  write(path.join(ai, 'app', 'main.py'), 'print(1)')
  write(path.join(ai, 'hooks', 'pre-commit'), '#!/bin/sh')
  write(path.join(ai, 'voice.json'), '{"my":"voice"}')
  write(path.join(ai, 'config.json'), '{"v":1,"my":"config"}')
  write(path.join(ai, 'openclaw', 'device.json'), '{"mine":true}')
  write(path.join(ai, 'hermes', 'backup.json'), '{"mine":true}')
  return ai
}
const FOREIGN = ['models/llama-3-70b.gguf', 'models/sdxl/unet.safetensors', 'app/main.py', 'hooks/pre-commit', 'voice.json', 'config.json', 'openclaw/device.json', 'hermes/backup.json']

test('A1: an existing folder with other things is not marked; purge and the program copies leave its files alone', () => {
  const ai = foreignFolder()
  withHome(ai, () => {
    ensureHome()
    assert.equal(fs.existsSync(path.join(ai, HOME_MARKER)), false, 'no marker')
    assert.match(purgeBlocker(ai), /no \.hinty-agents-home/)
    // the service starts and writes its own files next to the foreign ones
    write(path.join(ai, 'daemon.log'), '2026-11-21T10:00:00.000Z start pid=1\n')
    noteCreated(path.join(ai, 'daemon.log'))
    assert.equal(removeProgramCopies().removed.length, 0)
    const r = purgeHome()
    assert.equal(r.folderGone, false)
    assert.ok(r.removed.includes('daemon.log'), 'what proves itself as ours may go')
    for (const f of FOREIGN) assert.equal(fs.existsSync(path.join(ai, f)), true, f)
  })
})

test('A1: `uninstall --all --purge` in that folder keeps every foreign file (CLI, isolated profile)', () => {
  const ai = foreignFolder()
  const user = tmp('hinty-r4-user-')
  const env = { ...process.env, HINTY_AGENTS_HOME: ai, HOME: user, USERPROFILE: user, CLAUDE_CONFIG_DIR: path.join(user, '.claude'), CODEX_HOME: path.join(user, '.codex'), HERMES_HOME: path.join(user, '.hermes'), HINTY_AGENTS_NO_NOTIFY: '1', NO_COLOR: '1', DISABLE_AUTOUPDATER: '1', HINTY_AGENTS_CLAUDE: path.join(user, 'none', 'claude.exe') }
  const r = spawnSync(process.execPath, [CLI, 'uninstall', '--all', '--purge'], { env, encoding: 'utf8', timeout: 90000, windowsHide: true, input: '' })
  assert.match(r.stderr + r.stdout, /existing folder|itself stays|Left in/, r.stdout + r.stderr)
  for (const f of FOREIGN) assert.equal(fs.existsSync(path.join(ai, f)), true, `${f}\n${r.stdout}${r.stderr}`)
})

test('A1: in a folder we created the marker lists our entries; purge removes only those and only our own files', () => {
  const h = path.join(tmp(), 'data')
  withHome(h, () => {
    ensureHome()
    const m = () => JSON.parse(fs.readFileSync(path.join(h, HOME_MARKER), 'utf8'))
    assert.deepEqual(m().entries, [])
    installScripts()
    write(path.join(h, 'config.json'), '{"v":1,"api":"x"}'); noteCreated(path.join(h, 'config.json'))
    fs.mkdirSync(path.join(h, 'models', 'parakeet-v3'), { recursive: true }); noteCreated(path.join(h, 'models'))
    assert.deepEqual(m().entries.sort(), ['config.json', 'hooks', 'models'])
    // later the person adds things of their own: next to ours, inside our folders, and a whole new folder
    write(path.join(h, 'hooks', 'pre-commit'), 'mine')
    write(path.join(h, 'models', 'llama.gguf'), 'mine')
    write(path.join(h, 'models', 'parakeet-v3', 'encoder.int8.onnx'), 'not the registry file (wrong size)')
    write(path.join(h, 'models', 'parakeet-v3', 'tokens.txt.123.part'), 'a partial download of ours')
    write(path.join(h, 'app', 'main.py'), 'mine')
    write(path.join(h, 'voice.json'), '{"v":1,"model":"parakeet-v3"}')
    const r = purgeHome()
    assert.deepEqual(r.removed.sort(), ['config.json'].sort())
    assert.equal(r.folderGone, false)
    for (const f of ['hooks/pre-commit', 'models/llama.gguf', 'models/parakeet-v3/encoder.int8.onnx', 'app/main.py', 'voice.json']) assert.equal(fs.existsSync(path.join(h, f)), true, f)
    for (const f of ['config.json', 'hooks/common.cjs', 'hooks/codex-hook.cjs', 'hooks/grok-hook.cjs', 'models/parakeet-v3/tokens.txt.123.part']) assert.equal(fs.existsSync(path.join(h, f)), false, f)
  })
})

test('A1: a folder we created and filled only with our own files is removed whole', () => {
  const h = path.join(tmp(), 'data')
  withHome(h, () => {
    ensureHome()
    installScripts()
    write(path.join(h, 'daemon.log'), 'x'); noteCreated(path.join(h, 'daemon.log'))
    write(path.join(h, 'voice', 'package.json'), '{"name":"hinty-agents-voice"}'); noteCreated(path.join(h, 'voice'))
    write(path.join(h, 'voice', 'node_modules', 'sherpa', 'index.js'))
    write(path.join(h, 'hermes', 'backup.json'), '{"v":1,"transport":null,"at":"2026-11-21T10:00:00.000Z"}'); noteCreated(path.join(h, 'hermes'))
    write(path.join(h, 'openclaw', 'tokens.json'), '{"v":2,"url":"ws://127.0.0.1:18789"}'); noteCreated(path.join(h, 'openclaw'))
    const r = purgeHome()
    assert.equal(r.folderGone, true, JSON.stringify(r))
    assert.equal(fs.existsSync(h), false)
  })
})

test('A1: a marker of 0.3.0 / 0.3.1 (plain text, no list) removes only entries that prove themselves as ours', () => {
  const h = tmp()
  fs.writeFileSync(path.join(h, HOME_MARKER), 'This folder belongs to hinty-agents (its data folder).\n')
  write(path.join(h, 'models', 'llama.gguf'), 'mine')
  write(path.join(h, 'hooks', 'pre-commit'), 'mine')
  write(path.join(h, 'config.json'), '{"v":1,"api":"x"}')
  withHome(h, () => {
    const r = purgeHome()
    assert.deepEqual(r.removed, ['config.json'])
    for (const f of ['models/llama.gguf', 'hooks/pre-commit']) assert.equal(fs.existsSync(path.join(h, f)), true, f)
  })
})

test('A1: program copies: only version folders with our package.json, temporary folders of our shape, manifests of our shape', () => {
  const h = path.join(tmp(), 'data')
  withHome(h, () => {
    ensureHome()
    const base = appBase()
    write(path.join(base, '.tmp-notes', 'a.txt'))
    write(path.join(base, '.old-backup', 'a.txt'))
    write(path.join(base, '.manifests', 'readme.md'))
    write(path.join(base, '.tmp-123-abc', 'a.txt'))
    write(path.join(base, '0.0.9', 'package.json'), JSON.stringify({ name: 'hinty-agents', version: '0.0.9' }))
    const r = removeProgramCopies()
    assert.deepEqual(r.removed.sort(), ['.tmp-123-abc', '0.0.9'])
    assert.deepEqual(r.kept.sort(), ['.manifests', '.old-backup', '.tmp-notes'])
    assert.ok(Object.hasOwn(MODELS, 'parakeet-v3'))
  })
})

// ================================================================ A3

test('A3: a HINTY_AGENTS_HOME with a part ending in a space, a tab or a dot is refused', () => {
  const base = tmp()
  const def = path.join(os.homedir(), '.hinty-agents')
  for (const bad of [path.join(base, 'shared '), path.join(base, 'shared\t'), path.join(base, 'shared.'), path.join(base, 'a ', 'b'), path.join(base, 'a.', 'b'), `${path.join(base, 'shared')} `]) {
    withHome(bad, () => assert.equal(homeDir(), def, JSON.stringify(bad)))
  }
  for (const good of [path.join(base, 'shared'), path.join(base, '.hinty'), path.join(base, 'a b', 'c.d')]) withHome(good, () => assert.equal(homeDir(), good))
  assert.equal(badPathPart(path.join(base, 'x ')), true)
  assert.equal(badPathPart(path.join(base, 'x')), false)
})

test('A3: the hook scripts refuse the same values', () => {
  const require = createRequire(import.meta.url)
  const { home } = require('../hooks/common.cjs')
  const base = tmp()
  const def = path.join(os.homedir(), '.hinty-agents')
  const saved = process.env.HINTY_AGENTS_HOME
  try {
    for (const bad of [`${path.join(base, 'shared')} `, path.join(base, 'shared\t'), path.join(base, 'shared.')]) { process.env.HINTY_AGENTS_HOME = bad; assert.equal(home(), def, JSON.stringify(bad)) }
    process.env.HINTY_AGENTS_HOME = path.join(base, 'shared'); assert.equal(home(), path.join(base, 'shared'))
  } finally { if (saved === undefined) delete process.env.HINTY_AGENTS_HOME; else process.env.HINTY_AGENTS_HOME = saved }
})

// ================================================================ A4

// --- copied from OpenClaw 2026.3.28 (the expressions, not a one-pass copy) ---
const MARKER = '[Current message - respond to this]'
const regexStrip = (text) => {
  if (!text) return ''
  return (text.includes(MARKER) ? text.slice(text.indexOf(MARKER) + 35).trimStart() : text).replace(/\[[^\]]+\]\s*/g, '').replace(/^[ \t]*[A-Za-z0-9+()\-_. ]+:\s*/gm, '').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim()
}

test('A4: the one-pass clean-up gives the same result as OpenClaw\'s expressions (200 000 random texts)', () => {
  const atoms = ['[', ']', '[]', '[x]', ':', 'a', 'b', 'x1', ' ', '  ', '\t', '\n', '\r', '\r\n', '\u2028', '\u2029', '\u00a0', '\u3000', '\ufeff', '\\', 'n', '\\n', '/', '!', '-', '_', '.', '(', ')', '+', 'é', '\u200b', MARKER, 'note:', 'a b:', ', ']
  let seed = 11
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  for (let i = 0; i < 200000; i++) {
    let s = ''
    for (let j = 1 + Math.floor(rnd() * 14); j > 0; j--) s += atoms[Math.floor(rnd() * atoms.length)]
    const want = regexStrip(s)
    const got = openclawStrip(s)
    if (want !== got) assert.equal(got, want, JSON.stringify(s))
  }
})

test('A4: a message of 8000 characters is made safe in well under 20 ms', () => {
  chatMessage(sayText('warm up'))
  for (const unit of [' ', 'x', '[', ']', '[]', ': ', 'a:\n', '/', '! ', ' /', '\\n', '[x]', 'x ', '\t', '][', ' x:']) {
    const text = unit.repeat(Math.ceil(8000 / unit.length)).slice(0, 8000)
    const t0 = process.hrtime.bigint()
    chatMessage(sayText(text))
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    assert.ok(ms < 20, `${JSON.stringify(unit)} x ${text.length}: ${ms.toFixed(1)} ms`)
  }
})
