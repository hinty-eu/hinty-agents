// @ts-check
// A stable copy of the package. `npx hinty-agents` runs from a cache folder npm may clean at any time; the service, the
// agents' hook files and Claude Code's plugin marketplace must not point into it. Setup, `start` and `install` copy the
// package (its `files` plus the runtime dependencies) to <data folder>/app/<version>/ and use that copy from then on.
// A git checkout (development) and a package already running from the copy are used as they are.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureHome, homeDir, narrowHome, noteCreated } from './store.js'
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

// ------------------------------------------------------------------------------------------------
// Manifest of a copy (security review 3, 6b): a folder named like the version is not trusted by its name. When the copy
// is made, the size and sha256 of every file go to <data folder>/app/.manifests/<version>.json (a folder with access
// narrowed to the owner); before the copy is used it is checked against it. A copy without a manifest or with any
// difference is copied again from the package (or, when the program runs from the copy itself, refused).
// ------------------------------------------------------------------------------------------------

export const manifestDir = () => path.join(appBase(), '.manifests')
/** @param {string} version */
export const manifestFile = (version) => path.join(manifestDir(), `${version}.json`)

/** every file under <dir> as posix relative paths (links are not followed: a copy has none) @param {string} dir */
function listFiles(dir) {
  /** @type {string[]} */
  const out = []
  const walk = (/** @type {string} */ d, /** @type {string} */ rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), r)
      else out.push(e.isFile() ? r : `${r}\0link`)
    }
  }
  walk(dir, '')
  return out.sort()
}

const sha256File = (/** @type {string} */ f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

/** @param {string} dir @param {string} version @returns {{ v: 1, version: string, files: Record<string, { size: number, sha256: string }> }} */
export function buildManifest(dir, version) {
  /** @type {Record<string, { size: number, sha256: string }>} */
  const files = {}
  for (const r of listFiles(dir)) {
    if (r.endsWith('\0link')) throw new Error(`the copy holds a link: ${r.slice(0, -5)}`)
    const f = path.join(dir, ...r.split('/'))
    files[r] = { size: fs.statSync(f).size, sha256: sha256File(f) }
  }
  return { v: 1, version, files }
}

/** @param {string} version @param {ReturnType<typeof buildManifest>} m */
function saveManifest(version, m) {
  const d = manifestDir()
  const fresh = !fs.existsSync(d)
  fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  noteCreated(d)
  if (fresh) narrowHome(d)
  const tmp = `${manifestFile(version)}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(m) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, manifestFile(version))
}

/**
 * Does <dir> match its manifest? `quick`: the manifest's files are there with their sizes (the service started by a
 * hook); otherwise every sha256 too and no file the manifest does not list (`start`, `install`, `doctor`, setup).
 * @param {string} dir @param {string} version @param {{ quick?: boolean }} [o] @returns {{ ok: boolean, why: string }}
 */
export function verifyCopy(dir, version, o = {}) {
  /** @type {any} */
  let m = null
  try { m = JSON.parse(fs.readFileSync(manifestFile(version), 'utf8')) } catch { return { ok: false, why: 'no manifest' } }
  if (!m || m.v !== 1 || m.version !== version || !m.files || typeof m.files !== 'object') return { ok: false, why: 'manifest not readable' }
  const pkg = readPkg(dir)
  if (!pkg || pkg.name !== 'hinty-agents' || pkg.version !== version) return { ok: false, why: 'package.json is not this version' }
  const names = Object.keys(m.files)
  if (!names.includes('bin/hinty-agents.js') || !names.includes('package.json')) return { ok: false, why: 'manifest incomplete' }
  for (const r of names) {
    if (r.split('/').some((x) => x === '..' || x === '' || x === '.')) return { ok: false, why: 'manifest has a bad path' }
    const f = path.join(dir, ...r.split('/'))
    let st
    try { st = fs.lstatSync(f) } catch { return { ok: false, why: `missing: ${r}` } }
    if (!st.isFile() || st.size !== m.files[r].size) return { ok: false, why: `changed: ${r}` }
    if (!o.quick && sha256File(f) !== m.files[r].sha256) return { ok: false, why: `changed: ${r}` }
  }
  if (!o.quick) {
    const extra = listFiles(dir).filter((r) => !Object.prototype.hasOwnProperty.call(m.files, r))
    if (extra.length) return { ok: false, why: `not in the manifest: ${extra[0].replace('\0link', '')}` }
  }
  return { ok: true, why: '' }
}

/**
 * The copy this process runs from, checked (the service at start, quick; review 3, 6b). Not a copy (a git checkout,
 * a package folder) = nothing to check.
 * @param {{ quick?: boolean }} [o] @returns {{ ok: boolean, why: string, copy: boolean }}
 */
export function checkRunningCopy(o = {}) {
  const root = packageRoot()
  const base = appBase()
  if (!inside(base, root)) return { ok: true, why: '', copy: false }
  const pkg = readPkg(root)
  const r = verifyCopy(root, String(pkg && pkg.version), o)
  return { ...r, copy: true }
}

/**
 * Remove the program copies: version folders that hold our package.json of that version (never a folder with `.git`),
 * the manifests and unfinished temporary folders; anything else in app/ stays (it is not ours). The app folder itself
 * goes when nothing is left. @returns {{ removed: string[], kept: string[], failed: string[] }}
 */
export function removeProgramCopies() {
  const base = appBase()
  /** @type {string[]} */
  const removed = [], kept = [], failed = []
  let names = []
  try { names = fs.readdirSync(base) } catch { return { removed, kept, failed } }
  for (const n of names) {
    const p = path.join(base, n)
    let manifests = false
    if (n === '.manifests') { try { manifests = fs.readdirSync(p).every((x) => MANIFEST_FILE.test(x)) } catch { manifests = false } }
    const ours = manifests || TEMP_COPY.test(n) || isProgramCopy(n)
    if (!ours) { kept.push(n); continue }
    try { fs.rmSync(p, { recursive: true, force: true }); removed.push(n) } catch { failed.push(n) }
  }
  try { if (!fs.readdirSync(base).length) fs.rmdirSync(base) } catch { /* in use or not empty */ }
  return { removed, kept, failed }
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

/** names of the temporary folders ensureApp makes: .tmp-<pid>-<time>, .old-<pid>-<time> */
const TEMP_COPY = /^\.(?:tmp|old)-\d+-[0-9a-z]+$/
/** a file of .manifests/: <version>.json (or its unfinished temporary file) */
const MANIFEST_FILE = /^\d+\.\d+\.\d+[-+.0-9A-Za-z]*?\.json(?:\.\d+\.tmp)?$/
/** is app/<name> a program copy of ours: a version folder with our package.json of that version, no .git @param {string} name */
function isProgramCopy(name) {
  const p = path.join(appBase(), name)
  const pkg = readPkg(p)
  return /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(name) && !!pkg && pkg.name === 'hinty-agents' && pkg.version === name && !fs.existsSync(path.join(p, '.git'))
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
    if (TEMP_COPY.test(n)) {
      try { fs.rmSync(path.join(base, n), { recursive: true, force: true }); removed.push(n) } catch { /* in use */ }
    }
  }
  // only version folders that hold our own package.json of that version (review 4, A1: app/ may hold other things)
  const versions = names.filter((n) => /^\d+\.\d+\.\d+/.test(n) && n !== current && isProgramCopy(n)).sort(cmpVersion).reverse()
  for (const n of versions.slice(1)) {
    try { fs.rmSync(path.join(base, n), { recursive: true, force: true }); removed.push(n) } catch { /* in use: next time */ }
  }
  // manifests of versions that are gone
  let kept = []
  try { kept = fs.readdirSync(manifestDir()) } catch { /* none */ }
  for (const f of kept) {
    const v = f.replace(/\.json$/, '')
    if (f.endsWith('.json') && !fs.existsSync(path.join(base, v))) { try { fs.unlinkSync(path.join(manifestDir(), f)) } catch { /* next time */ } }
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
  if (inside(base, src)) {
    // running from a copy: it must match its manifest; it cannot be copied again from itself, so a mismatch is refused
    const own = readPkg(src)
    const v = verifyCopy(src, String(own && own.version))
    if (!v.ok) throw new Error(`the program copy ${src} does not match the manifest written when it was made (${v.why}); copy it again: npx hinty-agents@${own && own.version ? own.version : 'latest'} start`)
    setActiveRoot(src)
    return { root: src, copied: false, dev: false, removed: [] }
  }
  if (same(src, base)) { setActiveRoot(src); return { root: src, copied: false, dev: false, removed: [] } }
  if (isDevCheckout(src)) { setActiveRoot(src); return { root: src, copied: false, dev: true, removed: [] } }
  const pkg = readPkg(src)
  if (!pkg) throw new Error('package.json not found next to the program')
  const version = String(pkg.version)
  ensureHome()
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  noteCreated(base)
  const target = path.join(base, version)
  let copied = false
  // an existing folder of this version counts only when it matches the manifest we wrote when we made it (6b)
  if (!verifyCopy(target, version).ok) {
    const tmp = path.join(base, `.tmp-${process.pid}-${Date.now().toString(36)}`)
    try {
      copyPackage(src, tmp)
      const manifest = buildManifest(tmp, version)
      if (fs.existsSync(target)) fs.renameSync(target, path.join(base, `.old-${process.pid}-${Date.now().toString(36)}`))
      fs.renameSync(tmp, target)
      saveManifest(version, manifest)
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
