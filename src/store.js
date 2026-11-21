// @ts-check
// Files in ~/.hinty-agents (or $HINTY_AGENTS_HOME): config.json (server, bridge token), daemon.json (local port and
// secret of the running service), daemon.lock, daemon.log. The folder is readable by the user only.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isAbsPath, sysExe } from './exec.js'
import { PV } from './localauth.js'
import { activeRoot } from './root.js'
import { SCRIPTS } from './adapters/hookfiles.js'
import { MODELS } from './stt/models.js'

export const DEFAULT_API = 'https://api.v1.hinty.eu'

let warnedHome = false
/**
 * The data folder: $HINTY_AGENTS_HOME when it is an ABSOLUTE path, else ~/.hinty-agents. A relative value (which would
 * point into whatever folder a command runs in, e.g. a repository) is ignored with a warning (security review point 8).
 */
export function homeDir() {
  const own = process.env.HINTY_AGENTS_HOME
  if (own && isAbsPath(own) && !badPathPart(path.resolve(own))) return own
  if (own && !warnedHome) {
    warnedHome = true
    // a part of the path that ends in a space, a tab or a dot is another folder for Windows tools (icacls, Explorer)
    // than for Node (security review 4, A3): such a value is refused like a relative one
    process.emitWarning(isAbsPath(own)
      ? 'HINTY_AGENTS_HOME has a part that ends in a space, a tab or a dot; it is ignored and ~/.hinty-agents is used'
      : 'HINTY_AGENTS_HOME is not an absolute path; it is ignored and ~/.hinty-agents is used', { code: 'HINTY_AGENTS_HOME' })
  }
  return path.join(os.homedir(), '.hinty-agents')
}

/** Does any part of the (resolved) path end in a space, a tab or a dot? @param {string} p */
export const badPathPart = (p) => p.split(/[\\/]/).some((seg) => /[ \t.]$/.test(seg))

export const paths = () => {
  const h = homeDir()
  return {
    home: h,
    config: path.join(h, 'config.json'),
    daemon: path.join(h, 'daemon.json'),
    lock: path.join(h, 'daemon.lock'),
    log: path.join(h, 'daemon.log'),
  }
}

/** @typedef {{ ok: boolean, checked: boolean, problem: string }} HomeAccess */
/** the folder whose access this process already narrowed and checked, and the result (doctor and status show it) */
let homeChecked = ''
/** @type {HomeAccess} */
let homeAccessState = { ok: true, checked: false, problem: '' }
export const homeAccess = () => homeAccessState

/**
 * Create the folder and narrow its access to the owner, at EVERY start of the CLI and the service (once per process),
 * not only when it is created: a folder that existed before (made by hand, restored from a backup, HINTY_AGENTS_HOME on
 * another drive) keeps whatever it inherited (security review 2, Z7). 0700 elsewhere; on Windows the ACL is set to the
 * user (by SID) and SYSTEM, and the result is read back.
 */
export function ensureHome() {
  const h = homeDir()
  if (homeChecked !== h) {
    // new or empty at the first use = ours; a folder that already holds things is only ever cleaned entry by entry
    let fresh = true
    try { fresh = fs.readdirSync(h).length === 0 } catch { /* not there yet */ }
    fs.mkdirSync(h, { recursive: true, mode: 0o700 })
    homeChecked = h
    // a HINTY_AGENTS_HOME that is your home folder, a drive or a system folder never has its access changed (6a)
    const prot = protectedFolder(h)
    homeAccessState = prot
      ? { ok: false, checked: true, problem: `HINTY_AGENTS_HOME is not a folder of its own (${prot}), so its access was not changed` }
      : narrowHome(h)
    markHome(h, fresh)
  } else {
    fs.mkdirSync(h, { recursive: true, mode: 0o700 })
  }
  return h
}

// ------------------------------------------------------------------------------------------------
// Whose folder is it? (`uninstall --all --purge` deletes only what is ours)
// ------------------------------------------------------------------------------------------------

/** Written into the data folder only when we created it or it was empty at the first use (security review 4, A1). It
 * lists the top-level entries WE created (`noteCreated`); `uninstall --purge` removes only those. A folder that already
 * held other things never gets it. (0.3.0 and 0.3.1 wrote a plain-text marker without a list; it is read as "no list".) */
export const HOME_MARKER = '.hinty-agents-home'

/** Every top-level entry this program creates in the data folder (and the temporary files of writeJson). */
const OUR_ENTRIES = new Set([HOME_MARKER, 'config.json', 'daemon.json', 'daemon.lock', 'daemon.log', 'daemon.log.1', 'app', 'hooks',
  'openclaw', 'hermes', 'models', 'voice', 'voice.json', 'hotwords.txt'])
/** @param {string} name */
export const isOurEntry = (name) => OUR_ENTRIES.has(name) || /^(?:config|daemon|voice)\.json\.\d+\.tmp$/.test(name)

/** @param {string} p */
const canon = (p) => {
  let r = path.resolve(p)
  try { r = fs.realpathSync.native(r) } catch { /* keep */ }
  return process.platform === 'win32' ? r.toLowerCase().replace(/[\\/]+$/, '') : r.replace(/\/+$/, '') || '/'
}
/** is `a` the same folder as `b` or one of its parents? @param {string} a @param {string} b */
const coversFolder = (a, b) => {
  const x = canon(a), y = canon(b)
  if (x === y) return true
  const rel = path.relative(x, y)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Why this folder must never be deleted as a whole or have entries removed by name: a drive or file system root, the
 * user's home folder or one of its parents, a system or program folder, the temporary folder (or a parent of any of
 * them). '' = none of these. Pure on the environment.
 * @param {string} dir @returns {string}
 */
export function protectedFolder(dir) {
  const r = canon(dir)
  if (r === canon(path.parse(path.resolve(dir)).root)) return 'it is the root of a drive'
  const env = process.env
  const special = [
    ['your home folder', os.homedir()], ['your home folder', env.USERPROFILE], ['your home folder', env.HOME],
    ['the temporary folder', os.tmpdir()],
    ...(process.platform === 'win32'
      ? [env.SystemRoot, env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.ProgramData, env.APPDATA, env.LOCALAPPDATA, env.PUBLIC, env.ALLUSERSPROFILE].map((p) => ['a system folder', p])
      : ['/usr', '/etc', '/bin', '/sbin', '/lib', '/var', '/opt', '/tmp', '/home', '/Users', '/root', '/System', '/Library', '/Applications', '/private'].map((p) => ['a system folder', p])),
  ]
  for (const [what, p] of special) {
    if (typeof p === 'string' && p && path.isAbsolute(p) && coversFolder(r, p)) return canon(p) === r ? `it is ${what}` : `it holds ${what}`
  }
  return ''
}

let warnedExisting = false
/** @param {string} h @param {boolean} fresh the folder did not exist or was empty before this first use */
function markHome(h, fresh) {
  const marker = path.join(h, HOME_MARKER)
  try {
    if (fs.existsSync(marker) || protectedFolder(h)) return
    if (!fresh) {
      if (!warnedExisting && canon(h) !== canon(path.join(os.homedir(), '.hinty-agents'))) {
        warnedExisting = true
        process.emitWarning('HINTY_AGENTS_HOME points to an existing folder; uninstall --purge will remove only files hinty-agents created', { code: 'HINTY_AGENTS_HOME' })
      }
      return
    }
    const note = 'This folder was created for hinty-agents (its data folder). `entries` lists what hinty-agents itself created in it; `npx hinty-agents uninstall --all --purge` removes only those.'
    fs.writeFileSync(marker, JSON.stringify({ v: 2, note, entries: [] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  } catch { /* unmarked: purge then removes only what its content proves is ours */ }
}

/** @param {string} h @returns {{ v: 2, note: string, entries: string[] } | 'legacy' | null} */
function readMarker(h) {
  let raw
  try { raw = fs.readFileSync(path.join(h, HOME_MARKER), 'utf8') } catch { return null }
  try {
    const j = JSON.parse(raw)
    if (j && j.v === 2 && Array.isArray(j.entries)) return { v: 2, note: String(j.note || ''), entries: j.entries.filter((/** @type {unknown} */ e) => typeof e === 'string') }
  } catch { /* the plain-text marker of 0.3.0 / 0.3.1 */ }
  return 'legacy'
}

const noted = new Set()
/**
 * Record that this program created `file` inside the data folder: its top-level entry goes into the marker's list.
 * Called where a file or folder of ours is made (config, daemon files, hooks, openclaw, hermes, models, voice, app, log).
 * Nothing happens without a v2 marker (a folder we did not create) or for a path outside the data folder.
 * @param {string} file
 */
export function noteCreated(file) {
  try {
    const h = homeDir()
    const rel = path.relative(h, file)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return
    const top = rel.split(/[\\/]/)[0]
    if (top === HOME_MARKER || !isOurEntry(top)) return
    const key = `${h}|${top}`
    if (noted.has(key)) return
    const m = readMarker(h)
    if (!m || m === 'legacy') return
    noted.add(key)
    if (m.entries.includes(top)) return
    m.entries.push(top)
    const marker = path.join(h, HOME_MARKER)
    const tmp = `${marker}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, marker)
  } catch { /* an entry left out of the list is simply not purged */ }
}

/**
 * Without a v2 marker (a folder that already held other things, or a 0.3.0 / 0.3.1 folder) an entry counts as ours only
 * when its content says so (its name alone could be a coincidence: a `models` or `hooks` folder of somebody else's).
 * @param {string} h @param {string} n
 */
function provablyOurs(h, n) {
  const p = path.join(h, n)
  const has = (/** @type {string} */ f) => fs.existsSync(path.join(p, f))
  /** @param {string} f */
  const text = (f) => { try { return fs.readFileSync(path.join(p, f), 'utf8') } catch { return '' } }
  try {
    switch (n) {
      case 'config.json': { const j = readJson(p); return !!j && j.v === 1 && typeof j.api === 'string' }
      case 'daemon.json': { const j = readJson(p); return !!j && Number.isInteger(j.pid) && (j.pv !== undefined || typeof j.secret === 'string') }
      case 'daemon.lock': return /^\d+\s*$/.test(fs.readFileSync(p, 'utf8'))
      case 'daemon.log': case 'daemon.log.1': return /^\d{4}-\d\d-\d\dT[\d:.]+Z \w/.test(fs.readFileSync(p, 'utf8').slice(0, 64))
      case 'voice.json': { const j = readJson(p); return !!j && j.v === 1 && typeof j.model === 'string' && Object.hasOwn(MODELS, j.model) }
      case 'hooks': return /Hinty Agents/.test(text('common.cjs'))
      case 'openclaw': return fs.readdirSync(p).some((x) => ownJsonFile(p, x))
      case 'hermes': return ownJsonFile(p, 'backup.json')
      case 'voice': return /"hinty-agents-voice"/.test(text('package.json'))
      case 'models': return fs.readdirSync(p).some((x) => Object.hasOwn(MODELS, x))
      case 'app': return true // only an empty folder is removed
      default: return TMP_NAME.test(n)
    }
  } catch { return false }
}

const TMP_NAME = /^(?:config|daemon|voice)\.json\.\d+\.tmp$/
const isIdentity = (/** @type {any} */ j) => j.version === 1 && typeof j.deviceId === 'string' && typeof j.publicKeyPem === 'string' && typeof j.privateKeyPem === 'string'
/** the JSON files we write in openclaw/ and hermes/, and what proves a file of that name is ours */
const OWN_JSON = {
  'approver.json': isIdentity, 'writer.json': isIdentity, 'device.json': isIdentity,
  'tokens.json': (/** @type {any} */ j) => j.v === 2 && typeof j.url === 'string',
  'orphans.json': (/** @type {any} */ j) => j.v === 1 && Array.isArray(j.devices),
  'backup.json': (/** @type {any} */ j) => j.v === 1 && typeof j.at === 'string',
}
/** @param {string} dir @param {string} name */
function ownJsonFile(dir, name) {
  if (!Object.hasOwn(OWN_JSON, name)) return false
  const j = readJson(path.join(dir, name))
  return !!j && typeof j === 'object' && OWN_JSON[/** @type {keyof typeof OWN_JSON} */ (name)](j)
}

/** SHA-256 of a file, read in pieces (a model is hundreds of MB). @param {string} file */
function sha256Sync(file) {
  const hash = crypto.createHash('sha256')
  const buf = Buffer.alloc(1 << 20)
  const fd = fs.openSync(file, 'r')
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (!n) break
      hash.update(buf.subarray(0, n))
    }
  } finally { fs.closeSync(fd) }
  return hash.digest('hex')
}

/**
 * Remove from <dir> the entries `ours` accepts; then the folder itself when nothing else is in it. Throws when an
 * entry could not be removed. @param {string} dir @param {(name: string, full: string, st: fs.Stats) => boolean} ours
 */
function removeOurs(dir, ours) {
  let left = false
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    let st
    try { st = fs.lstatSync(full) } catch { continue }
    if (ours(name, full, st)) fs.rmSync(full, { recursive: true, force: true })
    else left = true
  }
  if (!left) { try { fs.rmdirSync(dir) } catch { /* in use */ } }
}

/** the files of our sub-folders, never the folders of somebody else's (review 4, A1) @param {string} h @param {string} n */
function purgeFolder(h, n) {
  const dir = path.join(h, n)
  const isFile = (/** @type {fs.Stats} */ st) => st.isFile()
  switch (n) {
    case 'hooks': return removeOurs(dir, (name, _f, st) => isFile(st) && SCRIPTS.includes(name))
    case 'openclaw': case 'hermes': return removeOurs(dir, (name, _f, st) => isFile(st) && (ownJsonFile(dir, name) || (Object.hasOwn(OWN_JSON, name.replace(/\.\d+\.tmp$/, '')) && /\.\d+\.tmp$/.test(name))))
    case 'voice': {
      const pk = readJson(path.join(dir, 'package.json'))
      if (!pk || pk.name !== 'hinty-agents-voice') return
      return removeOurs(dir, (name, _f, st) => (isFile(st) && (name === 'package.json' || name === 'package-lock.json')) || (name === 'node_modules' && (st.isDirectory() || st.isSymbolicLink())))
    }
    case 'models': return removeOurs(dir, (id, full, st) => {
      if (!st.isDirectory() || !Object.hasOwn(MODELS, id)) return false
      const files = new Map(MODELS[/** @type {keyof typeof MODELS} */ (id)].files.map((f) => [f.name, f]))
      removeOurs(full, (name, p, s) => {
        if (!s.isFile()) return false
        const part = /^(.+)\.\d+\.part$/.exec(name)
        if (part && files.has(part[1])) return true
        const f = files.get(name)
        return !!f && s.size === f.size && sha256Sync(p) === f.sha256
      })
      return !fs.existsSync(full)
    })
    case 'app': { try { fs.rmdirSync(dir) } catch { /* not empty: removeProgramCopies decides what goes */ } return }
    default: fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * `uninstall --all --purge` (review 3, 6a; review 4, A1): remove what this program created in the data folder and
 * nothing else. In a folder we created (v2 marker) only the entries on the marker's list, and of those only our own
 * files (a `models` folder loses the registry files whose checksum matches and our partial downloads, a `hooks` folder
 * our three scripts, ...); the folder itself goes when nothing else is left. In any other folder only entries whose
 * content proves they are ours, and the folder stays. Never call it for a protected folder (`protectedFolder`): the
 * caller refuses those.
 * @param {string} [h] @returns {{ removed: string[], failed: string[], left: string[], folderGone: boolean }}
 */
export function purgeHome(h = homeDir()) {
  /** @type {string[]} */
  const removed = [], failed = []
  if (protectedFolder(h)) return { removed, failed, left: ['(protected folder)'], folderGone: false }
  const marker = readMarker(h)
  const ours = !purgeBlocker(h)
  const listed = marker && marker !== 'legacy' ? new Set(marker.entries) : null
  let names = []
  try { names = fs.readdirSync(h) } catch { return { removed, failed, left: [], folderGone: !fs.existsSync(h) } }
  for (const n of names) {
    if (n === HOME_MARKER || !isOurEntry(n)) continue
    if (listed ? !(listed.has(n) || TMP_NAME.test(n)) : !provablyOurs(h, n)) continue
    try {
      if (fs.lstatSync(path.join(h, n)).isDirectory()) purgeFolder(h, n)
      else fs.rmSync(path.join(h, n), { force: true })
      if (!fs.existsSync(path.join(h, n))) removed.push(n)
    } catch { failed.push(n) }
  }
  let left = []
  try { left = fs.readdirSync(h).filter((n) => n !== HOME_MARKER) } catch { /* gone */ }
  let folderGone = false
  if (ours && !left.length) {
    try { fs.rmSync(path.join(h, HOME_MARKER), { force: true }); fs.rmdirSync(h); folderGone = !fs.existsSync(h) } catch { /* in use */ }
  }
  return { removed, failed, left, folderGone }
}

/** @returns {string} why the data folder is not ours to purge ('' = it is) */
export function purgeBlocker(h = homeDir()) {
  const prot = protectedFolder(h)
  if (prot) return prot
  if (!fs.existsSync(path.join(h, HOME_MARKER))) return `it was not created by hinty-agents (no ${HOME_MARKER} in it)`
  return ''
}

/** @param {string} dir @returns {HomeAccess} */
export function narrowHome(dir) {
  if (process.platform === 'win32') {
    const r = restrictWindowsAcl(dir)
    return { ok: r.ok, checked: true, problem: r.ok ? '' : r.why }
  }
  try { fs.chmodSync(dir, 0o700) } catch { /* checked below */ }
  try {
    const st = fs.statSync(dir)
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { ok: false, checked: true, problem: `the folder belongs to user id ${st.uid}, not to you` }
    if (st.mode & 0o077) return { ok: false, checked: true, problem: `the folder has mode ${(st.mode & 0o777).toString(8)} (others can open it)` }
  } catch { return { ok: false, checked: true, problem: 'the folder cannot be read' } }
  return { ok: true, checked: true, problem: '' }
}

/** @type {string | null} */
let sidCache = null
/** The SID of the account this process runs as (`whoami /user`), or ''. Never the USERNAME variable. */
export function currentUserSid() {
  if (sidCache !== null) return sidCache
  const r = spawnSync(sysExe('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10000, cwd: os.homedir() })
  const m = r.status === 0 ? String(r.stdout || '').match(/"(S-1-[0-9]+(?:-[0-9]+)+)"\s*$/m) : null
  sidCache = m ? m[1] : ''
  return sidCache
}

/** SDDL short names of well-known accounts (what `icacls /save` writes instead of a SID) */
const SDDL_ALIAS = /** @type {Record<string, string>} */ ({
  SY: 'S-1-5-18', BA: 'S-1-5-32-544', AU: 'S-1-5-11', WD: 'S-1-1-0', BU: 'S-1-5-32-545', IU: 'S-1-5-4', AN: 'S-1-5-7',
  NU: 'S-1-5-2', SU: 'S-1-5-6', CO: 'S-1-3-0', CG: 'S-1-3-1', OW: 'S-1-3-4', LS: 'S-1-5-19', NS: 'S-1-5-20',
  PU: 'S-1-5-32-547', BG: 'S-1-5-32-546', RD: 'S-1-5-32-555', RU: 'S-1-5-32-554', AC: 'S-1-15-2-1', LG: '', DU: '', DA: '', EA: '',
})

/**
 * Accounts that have an ALLOW entry on a file or folder, read from `icacls <path> /save` (SDDL), as SIDs. Pure on the
 * text (exported for tests). Aliases without a fixed SID (domain groups) come back as `alias:XX`.
 * @param {string} sddl @returns {string[]}
 */
export function allowSids(sddl) {
  const dacl = String(sddl).match(/D:[A-Z]*((?:\([^)]*\))*)/)
  if (!dacl) return []
  const out = new Set()
  for (const ace of dacl[1].match(/\(([^)]*)\)/g) || []) {
    const f = ace.slice(1, -1).split(';')
    if (!['A', 'OA', 'XA', 'ZA'].includes(f[0])) continue
    const who = f[5] || ''
    out.add(/^S-1-/.test(who) ? who : SDDL_ALIAS[who] || `alias:${who}`)
  }
  return [...out]
}

/** @param {string} target @returns {string[] | null} the allow SIDs of `target`, null when icacls cannot tell */
function readAllowSids(target) {
  const tmp = path.join(os.tmpdir(), `hinty-acl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  try {
    const r = spawnSync(sysExe('icacls.exe'), [target, '/save', tmp], { stdio: 'ignore', windowsHide: true, timeout: 10000, cwd: os.homedir() })
    if (r.status !== 0) return null
    return allowSids(fs.readFileSync(tmp).toString('utf16le'))
  } catch { return null } finally { try { fs.unlinkSync(tmp) } catch { /* gone */ } }
}

/**
 * Windows: the folder (and what it holds) open to this account and SYSTEM only. Inherited entries are cut off, the two
 * grants are set by SID, any other allow entry is removed, and the result is read back (a failing icacls used to go
 * unnoticed). Administrators keep what Windows gives them anyway (they can take ownership).
 * @param {string} dir @returns {{ ok: boolean, why: string }}
 */
export function restrictWindowsAcl(dir) {
  const sid = currentUserSid()
  if (!sid) return { ok: false, why: 'the account SID could not be read (whoami /user)' }
  const icacls = (/** @type {string[]} */ args) => spawnSync(sysExe('icacls.exe'), [dir, ...args], { stdio: 'ignore', windowsHide: true, timeout: 15000, cwd: os.homedir() }).status === 0
  const allowed = new Set([sid, 'S-1-5-18', 'S-1-5-32-544'])
  let sids = readAllowSids(dir)
  const narrow = !sids || sids.some((s) => !allowed.has(s)) || !sids.includes(sid)
  if (narrow && !icacls(['/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'])) {
    return { ok: false, why: 'icacls could not change the folder\'s access' }
  }
  if (narrow) sids = readAllowSids(dir)
  if (!sids) return { ok: false, why: 'icacls could not read the folder\'s access' }
  for (const other of sids.filter((s) => !allowed.has(s) && /^S-1-/.test(s))) icacls(['/remove:g', `*${other}`])
  sids = readAllowSids(dir) || []
  const left = sids.filter((s) => !allowed.has(s))
  if (left.length) return { ok: false, why: `other accounts can still open it (${left.join(', ')})` }
  if (!sids.includes(sid)) return { ok: false, why: 'your account has no access entry' }
  return { ok: true, why: '' }
}

/** @param {string} file */
export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * Atomic write with owner-only mode.
 * @param {string} file @param {unknown} obj
 */
export function writeJson(file, obj) {
  ensureHome()
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
  noteCreated(file)
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600) } catch { /* best effort */ } }
}

/**
 * @typedef {{ v: 1, api: string, bridgeToken?: string, bridgeId?: string, label?: string, host?: string,
 *   pairedAt?: string, entry?: string, stopped?: boolean, autostart?: boolean, account?: string,
 *   remoteAwayOn?: boolean, remoteAwayAt?: number, notify?: boolean, codex?: { queue?: boolean } }} Config
 * `remoteAwayOn`: the person agreed (wizard or `remote-away on`) that the Hinty panel / glasses may switch away mode ON;
 * absent or false = only this computer switches it on (switching it off remotely always works). `remoteAwayAt`: when
 * that consent was given (ms); a remote switch-on lasts at most until 12 h after the last switch-on or consent at this
 * computer. `codex.queue: false`: instructions for Codex go through the held Stop hook, never `codex queue --message`.
 */

/** @returns {Config | null} */
export const readConfig = () => readJson(paths().config)

/** @param {Partial<Config>} patch @returns {Config} */
export function updateConfig(patch) {
  const cur = readConfig() || { v: 1, api: process.env.HINTY_AGENTS_API || DEFAULT_API }
  const next = /** @type {Config} */ ({ ...cur, ...patch, v: 1 })
  for (const k of Object.keys(next)) if (/** @type {any} */ (next)[k] === undefined) delete /** @type {any} */ (next)[k]
  writeJson(paths().config, next)
  return next
}

/** @param {Config | null} c */
export const isPaired = (c) => !!(c && typeof c.bridgeToken === 'string' && c.bridgeToken.length >= 16)

/** @typedef {{ v: 2, pv: 2, pid: number, port: number, key: string, startedAt: string, version: string }} DaemonInfo */

/** @param {any} d @returns {d is DaemonInfo} daemon.json of the local protocol this version speaks (v2) */
export const isDaemonInfo = (d) => !!d && d.pv === PV && Number.isInteger(d.port) && d.port > 0 && d.port <= 65535 &&
  typeof d.key === 'string' && d.key.length >= 32 && Number.isInteger(d.pid)

/** @returns {DaemonInfo | null} */
export function readDaemonInfo() {
  const d = readJson(paths().daemon)
  return isDaemonInfo(d) ? d : null
}

/** daemon.json as it is, also of another version (an older service still running): `{pid, old}` or null. */
export function readDaemonAny() {
  const d = readJson(paths().daemon)
  if (!d || !Number.isInteger(d.pid)) return null
  return { pid: /** @type {number} */ (d.pid), old: !isDaemonInfo(d), info: isDaemonInfo(d) ? d : null }
}

/** @param {number} pid */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return /** @type {any} */ (e).code === 'EPERM' }
}

/** Absolute path of the CLI entry (used to start the service from the SessionStart hook). */
export const cliEntry = () => path.join(activeRoot(), 'bin', 'hinty-agents.js')
