// @ts-check
// Files in ~/.hinty-agents (or $HINTY_AGENTS_HOME): config.json (server, bridge token), daemon.json (local port and
// secret of the running service), daemon.lock, daemon.log. The folder is readable by the user only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isAbsPath, sysExe } from './exec.js'
import { PV } from './localauth.js'
import { activeRoot } from './root.js'

export const DEFAULT_API = 'https://api.v1.hinty.eu'

let warnedHome = false
/**
 * The data folder: $HINTY_AGENTS_HOME when it is an ABSOLUTE path, else ~/.hinty-agents. A relative value (which would
 * point into whatever folder a command runs in, e.g. a repository) is ignored with a warning (security review point 8).
 */
export function homeDir() {
  const own = process.env.HINTY_AGENTS_HOME
  if (own && isAbsPath(own)) return own
  if (own && !warnedHome) {
    warnedHome = true
    process.emitWarning('HINTY_AGENTS_HOME is not an absolute path; it is ignored and ~/.hinty-agents is used', { code: 'HINTY_AGENTS_HOME' })
  }
  return path.join(os.homedir(), '.hinty-agents')
}

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
  fs.mkdirSync(h, { recursive: true, mode: 0o700 })
  if (homeChecked !== h) {
    homeChecked = h
    homeAccessState = narrowHome(h)
  }
  return h
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
