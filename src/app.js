// @ts-check
// A stable copy of the package. `npx hinty-agents` runs from a cache folder npm may clean at any time; the service, the
// agents' hook files and Claude Code's plugin marketplace must not point into it. Setup, `start` and `install` copy the
// package (its `files` plus the runtime dependencies) to <data folder>/app/<version>/ and use that copy from then on.
// A git checkout (development) and a package already running from the copy are used as they are.
import fs from 'node:fs'
import path from 'node:path'
import { ensureHome, homeDir } from './store.js'
import { activeRoot, packageRoot, setActiveRoot } from './root.js'

export const appBase = () => path.join(homeDir(), 'app')

/** @param {string} p */
const same = (p, q) => {
  const norm = (/** @type {string} */ x) => { try { x = fs.realpathSync(x) } catch { /* keep */ } return process.platform === 'win32' ? x.toLowerCase() : x }
  return norm(p) === norm(q)
}

/** @param {string} root @param {string} dir */
const inside = (root, dir) => {
  const rel = path.relative(root, dir)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Is this folder a development checkout (no copy needed)? HINTY_AGENTS_DEV=1 forces yes, =0 forces no; otherwise a `.git`
 * next to package.json, outside any node_modules.
 * @param {string} root
 */
export function isDevCheckout(root) {
  const f = process.env.HINTY_AGENTS_DEV
  if (f === '1') return true
  if (f === '0') return false
  if (root.split(/[\\/]/).includes('node_modules')) return false
  return fs.existsSync(path.join(root, '.git'))
}

/** @param {string} root */
function readPkg(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) } catch { return null }
}

/** Is <dir> a complete copy of the given version? */
function validCopy(/** @type {string} */ dir, /** @type {string} */ version) {
  const pkg = readPkg(dir)
  return !!pkg && pkg.name === 'hinty-agents' && pkg.version === version &&
    fs.existsSync(path.join(dir, 'bin', 'hinty-agents.js')) && fs.existsSync(path.join(dir, 'node_modules', 'socket.io-client', 'package.json'))
}

const skip = (/** @type {string} */ src) => /(^|[\\/])__pycache__([\\/]|$)|\.pyc$/.test(src)

/** @param {string} from @param {string} to */
function copyTree(from, to) {
  fs.cpSync(from, to, { recursive: true, dereference: true, filter: (s) => !skip(s) })
}

/**
 * Where a dependency of the package at <fromDir> is installed: the nearest node_modules up the tree, like Node resolves.
 * @param {string} fromDir @param {string} name @returns {string | null}
 */
export function findDependency(fromDir, name) {
  let d = fromDir
  for (;;) {
    const cand = path.join(d, 'node_modules', name)
    if (fs.existsSync(path.join(cand, 'package.json'))) return cand
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
}

/**
 * Copy the runtime dependencies of <srcPkg> (and theirs) into <destPkg>/node_modules. Flat where a name is free, nested
 * under the requiring package when another version already took the top-level place.
 * @param {string} srcPkg @param {string} destTop @param {string} destPkg @param {Map<string, string>} top name -> source folder
 */
function copyDeps(srcPkg, destTop, destPkg, top) {
  const pkg = readPkg(srcPkg)
  for (const name of Object.keys((pkg && pkg.dependencies) || {})) {
    const src = findDependency(srcPkg, name)
    if (!src) throw new Error(`dependency ${name} of ${path.basename(srcPkg)} is not installed`)
    const real = fs.realpathSync(src)
    const placed = top.get(name)
    let dest
    if (!placed) { dest = path.join(destTop, 'node_modules', name); top.set(name, real) }
    else if (placed === real) continue
    else dest = path.join(destPkg, 'node_modules', name)
    if (fs.existsSync(dest)) continue
    copyTree(real, dest)
    // its own node_modules (if the source had nested ones) came along; the dependencies it lacks are added now
    copyDeps(real, destTop, dest, top)
  }
}

/**
 * Copy the package to a new folder: what package.json `files` lists, package.json itself and the runtime dependencies.
 * @param {string} srcRoot @param {string} dest (must not exist)
 */
export function copyPackage(srcRoot, dest) {
  const pkg = readPkg(srcRoot)
  if (!pkg) throw new Error('package.json not found')
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 })
  const entries = ['package.json', ...(pkg.files || []).filter((/** @type {string} */ f) => !f.startsWith('!')).map((/** @type {string} */ f) => f.replace(/\/+$/, ''))]
  for (const e of entries) {
    const from = path.join(srcRoot, e)
    if (fs.existsSync(from)) copyTree(from, path.join(dest, e))
  }
  copyDeps(srcRoot, dest, dest, new Map())
}

const semverKey = (/** @type {string} */ v) => v.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : 0))
const cmpVersion = (/** @type {string} */ a, /** @type {string} */ b) => {
  const x = semverKey(a), y = semverKey(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0)
  return 0
}

/**
 * Remove old versions after a successful switch: the current one and the newest other one stay (a service or an open
 * Claude Code session may still use the previous one); unfinished temporary folders go.
 * @param {string} current version folder name @returns {string[]} removed names
 */
export function pruneOld(current) {
  const base = appBase()
  const removed = []
  let names = []
  try { names = fs.readdirSync(base) } catch { return [] }
  for (const n of names) {
    if (n.startsWith('.tmp-') || n.startsWith('.old-')) {
      try { fs.rmSync(path.join(base, n), { recursive: true, force: true }); removed.push(n) } catch { /* in use */ }
    }
  }
  const versions = names.filter((n) => /^\d+\.\d+\.\d+/.test(n) && n !== current).sort(cmpVersion).reverse()
  for (const n of versions.slice(1)) {
    try { fs.rmSync(path.join(base, n), { recursive: true, force: true }); removed.push(n) } catch { /* in use: next time */ }
  }
  return removed
}

/**
 * Make sure the code the service, hooks and plugin marketplace use is the stable copy, and switch to it.
 * @param {{ srcRoot?: string }} [o]
 * @returns {{ root: string, copied: boolean, dev: boolean, removed: string[] }}
 */
export function ensureApp(o = {}) {
  const src = o.srcRoot || packageRoot()
  const base = appBase()
  if (inside(base, src) || same(src, base)) { setActiveRoot(src); return { root: src, copied: false, dev: false, removed: [] } }
  if (isDevCheckout(src)) { setActiveRoot(src); return { root: src, copied: false, dev: true, removed: [] } }
  const pkg = readPkg(src)
  if (!pkg) throw new Error('package.json not found next to the program')
  const version = String(pkg.version)
  ensureHome()
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const target = path.join(base, version)
  let copied = false
  if (!validCopy(target, version)) {
    const tmp = path.join(base, `.tmp-${process.pid}-${Date.now().toString(36)}`)
    try {
      copyPackage(src, tmp)
      if (fs.existsSync(target)) fs.renameSync(target, path.join(base, `.old-${process.pid}-${Date.now().toString(36)}`))
      fs.renameSync(tmp, target)
      copied = true
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* left for the next prune */ }
      throw e
    }
  }
  setActiveRoot(target)
  const removed = pruneOld(version)
  return { root: target, copied, dev: false, removed }
}

/** The program file the service is started from. */
export const appEntry = () => path.join(activeRoot(), 'bin', 'hinty-agents.js')
