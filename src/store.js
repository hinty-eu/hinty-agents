// @ts-check
// Files in ~/.hinty-agents (or $HINTY_AGENTS_HOME): config.json (server, bridge token), daemon.json (local port and
// secret of the running service), daemon.lock, daemon.log. The folder is readable by the user only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const DEFAULT_API = 'https://api.v1.hinty.eu'

export function homeDir() {
  return process.env.HINTY_AGENTS_HOME || path.join(os.homedir(), '.hinty-agents')
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

/** Create the folder with owner-only access (0700; on Windows the ACL is narrowed to the user and SYSTEM). */
export function ensureHome() {
  const h = homeDir()
  const existed = fs.existsSync(h)
  fs.mkdirSync(h, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    try { fs.chmodSync(h, 0o700) } catch { /* best effort */ }
  } else if (!existed) {
    restrictWindowsAcl(h)
  }
  return h
}

/** @param {string} dir */
export function restrictWindowsAcl(dir) {
  const user = process.env.USERNAME
  if (!user) return false
  const who = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user
  const r = spawnSync('icacls', [dir, '/inheritance:r', '/grant:r', `${who}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'],
    { stdio: 'ignore', windowsHide: true, timeout: 10000 })
  return r.status === 0
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
 *   pairedAt?: string, entry?: string, stopped?: boolean, autostart?: boolean }} Config
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

/** @typedef {{ v: 1, pid: number, port: number, secret: string, startedAt: string, version: string }} DaemonInfo */

/** @returns {DaemonInfo | null} */
export function readDaemonInfo() {
  const d = readJson(paths().daemon)
  if (!d || !Number.isInteger(d.port) || typeof d.secret !== 'string') return null
  return d
}

/** @param {number} pid */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return /** @type {any} */ (e).code === 'EPERM' }
}

/** Absolute path of the CLI entry (used to start the service from the SessionStart hook). */
export const cliEntry = () => fileURLToPath(new URL('../bin/hinty-agents.js', import.meta.url))
