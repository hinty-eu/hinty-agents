// Prepare what electron-builder packs next to the app (desktop/build/, not in git):
//   build/bridge  the hinty-agents package (the same files a program copy gets: package.json `files` plus the runtime
//                 dependencies), made with the bridge's own copyPackage
//   build/node    the official Node.js (version and sha256 pinned in node-runtime.mjs): the binary, npm, the licence
// Usage: node scripts/stage.mjs [--platform win32|darwin] [--arch x64|arm64]   (default: this computer)
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { copyPackage } from '../../src/app.js'
import { NODE_FILES, NODE_VERSION, nodeUrl } from './node-runtime.mjs'

const DESKTOP = fileURLToPath(new URL('../', import.meta.url))
const REPO = path.resolve(DESKTOP, '..')
const BUILD = path.join(DESKTOP, 'build')
const CACHE = path.join(DESKTOP, '.cache')
const arg = (/** @type {string} */ n, /** @type {string} */ d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const platform = arg('--platform', process.platform)
const arch = arg('--arch', process.arch)
const key = `${platform}-${arch}`
const pinned = NODE_FILES[key]
if (!pinned) { console.error(`No pinned Node.js for ${key} (have: ${Object.keys(NODE_FILES).join(', ')})`); process.exit(1) }

const sha256 = (/** @type {string} */ f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const tarExe = () => (process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar')

async function fetchNode() {
  fs.mkdirSync(CACHE, { recursive: true })
  const archive = path.join(CACHE, pinned.file)
  if (fs.existsSync(archive) && sha256(archive) !== pinned.sha256) fs.rmSync(archive)
  if (!fs.existsSync(archive)) {
    console.log(`downloading ${nodeUrl(pinned.file)}`)
    const res = await fetch(nodeUrl(pinned.file), { redirect: 'follow' })
    if (!res.ok) throw new Error(`download failed: ${res.status}`)
    const tmp = `${archive}.${process.pid}.part`
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))
    const got = sha256(tmp)
    if (got !== pinned.sha256) { fs.rmSync(tmp); throw new Error(`sha256 mismatch for ${pinned.file}: got ${got}, pinned ${pinned.sha256}`) }
    fs.renameSync(tmp, archive)
  }
  console.log(`Node.js ${NODE_VERSION} ${key}: sha256 ok (${pinned.sha256.slice(0, 16)}...)`)
  // unpack into a fresh folder, then keep only the binary, npm and the licence
  const unpack = path.join(CACHE, `unpack-${key}`)
  fs.rmSync(unpack, { recursive: true, force: true })
  fs.mkdirSync(unpack, { recursive: true })
  const r = spawnSync(tarExe(), [pinned.file.endsWith('.zip') ? '-xf' : '-xzf', archive, '-C', unpack], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('unpacking failed')
  const top = path.join(unpack, pinned.file.replace(/\.(zip|tar\.gz)$/, ''))
  const dest = path.join(BUILD, 'node')
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  const keep = platform === 'win32'
    ? [['node.exe', 'node.exe'], ['LICENSE', 'LICENSE'], ['node_modules/npm', 'node_modules/npm']]
    : [['bin/node', 'bin/node'], ['LICENSE', 'LICENSE'], ['lib/node_modules/npm', 'lib/node_modules/npm']]
  for (const [from, to] of keep) {
    const src = path.join(top, from)
    if (!fs.existsSync(src)) throw new Error(`missing in the archive: ${from}`)
    fs.cpSync(src, path.join(dest, to), { recursive: true, verbatimSymlinks: true })
  }
  fs.writeFileSync(path.join(dest, 'RUNTIME.json'), JSON.stringify({ node: NODE_VERSION, platform, arch, file: pinned.file, sha256: pinned.sha256, from: nodeUrl(pinned.file) }, null, 2) + '\n')
  fs.rmSync(unpack, { recursive: true, force: true })
  if (platform === process.platform && arch === process.arch) {
    const exe = platform === 'win32' ? path.join(dest, 'node.exe') : path.join(dest, 'bin', 'node')
    const v = spawnSync(exe, ['--version'], { encoding: 'utf8' })
    if (v.stdout.trim() !== `v${NODE_VERSION}`) throw new Error(`the bundled Node.js says ${v.stdout.trim()} ${v.stderr}`)
    const npm = spawnSync(exe, [platform === 'win32' ? path.join(dest, 'node_modules', 'npm', 'bin', 'npm-cli.js') : path.join(dest, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '--version'], { encoding: 'utf8' })
    if (npm.status !== 0) throw new Error(`the bundled npm does not start: ${npm.stderr}`)
    console.log(`bundled runtime: node ${v.stdout.trim()}, npm ${npm.stdout.trim()}`)
  }
}

function stageBridge() {
  const dest = path.join(BUILD, 'bridge')
  fs.rmSync(dest, { recursive: true, force: true })
  if (!fs.existsSync(path.join(REPO, 'node_modules', 'socket.io-client'))) throw new Error('run `npm ci` in the repository root first (socket.io-client)')
  copyPackage(REPO, dest)
  const pkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'))
  const own = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'))
  if (pkg.version !== own.version) throw new Error(`desktop/package.json ${own.version} is not the bridge's version ${pkg.version}`)
  console.log(`bridge hinty-agents ${pkg.version} staged in ${dest}`)
}

fs.mkdirSync(BUILD, { recursive: true })
stageBridge()
await fetchNode()
