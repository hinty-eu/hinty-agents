// @ts-check
// The hook scripts of the Codex and Grok adapters live in ~/.hinty-agents/hooks/ (a stable path: an `npx` cache folder
// may be cleaned later, and the agents' hook files point to these copies). Install copies them, uninstall of the last
// adapter that uses them leaves them (they are tiny and harmless without a hook entry).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { childEnv, sysExe } from '../exec.js'
import { ensureHome, homeDir } from '../store.js'

export const SCRIPTS = ['common.cjs', 'codex-hook.cjs', 'grok-hook.cjs']

export const sourceDir = () => path.resolve(fileURLToPath(new URL('../../hooks/', import.meta.url)))
export const hooksDir = () => path.join(homeDir(), 'hooks')

/** Copy the scripts into the data folder; returns the folder. */
export function installScripts() {
  ensureHome()
  const dest = hooksDir()
  fs.mkdirSync(dest, { recursive: true })
  for (const f of SCRIPTS) fs.copyFileSync(path.join(sourceDir(), f), path.join(dest, f))
  return dest
}

/** Quote a path for a command line (the agents run `command` through a shell). Forward slashes work on Windows too. */
export function q(/** @type {string} */ p) {
  return `"${p.replace(/\\/g, '/').replace(/"/g, '')}"`
}

const WIN = process.platform === 'win32'
/** characters no shell (cmd.exe, PowerShell, sh) splits, quotes or expands */
const BARE = /^[A-Za-z0-9_:\\/.+~-]+$/

/** The Node.js running now, with links resolved (an fnm / nvm shell folder is a link that goes away with the shell). */
export function nodeExe() {
  try { return fs.realpathSync(process.execPath) } catch { return process.execPath }
}

/**
 * The 8.3 short form of a Windows path (`C:\PROGRA~1\nodejs\node.exe`), or null. @param {string} p
 */
export function shortPath(p) {
  if (!WIN || /["%]/.test(p)) return null
  const r = spawnSync(sysExe('cmd.exe'), ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`],
    { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 10000, cwd: os.homedir(), env: childEnv() })
  const s = r.status === 0 ? String(r.stdout || '').trim() : ''
  return s && !/\s/.test(s) && fs.existsSync(s) ? s : null
}

/**
 * How a hook command starts Node (security review 2, Z3). Never `node` by name: Codex runs hook commands with cmd.exe in
 * the session's folder, and cmd.exe looks for a bare `node` in that folder first (a `node.cmd` in a cloned repository
 * would run). The full path, unquoted when it has nothing a shell would split (that form works in cmd.exe, PowerShell
 * and sh alike); on Windows a path with spaces is tried in its 8.3 short form, else written as `@"C:\...\node.exe"`: the
 * `@` keeps cmd.exe from eating the quotes when the command line starts with one (`cmd /c "a" "b"` loses the first and
 * the last quote), with or without /S. On other systems a path with spaces is single-quoted.
 * @param {string} [exe]
 */
export function nodeCommand(exe = nodeExe()) {
  const hit = nodeCmdCache.get(exe)
  if (hit) return hit
  const v = nodeCommandUncached(exe)
  nodeCmdCache.set(exe, v)
  return v
}
/** @type {Map<string, string>} */
const nodeCmdCache = new Map()

/** @param {string} exe */
function nodeCommandUncached(exe) {
  if (BARE.test(exe)) return exe
  if (WIN) {
    const s = shortPath(exe)
    if (s && BARE.test(s)) return s
    return `@"${exe.replace(/"/g, '')}"`
  }
  return `'${exe.replace(/'/g, "'\\''")}'`
}

/**
 * The Node.js a hook command starts: `node` for a command written by an older version, otherwise the path. Pure.
 * @param {unknown} cmd
 */
export function commandNode(cmd) {
  const c = String(cmd || '').trim()
  const m = c.match(/^@?"([^"]+)"/) || c.match(/^'((?:[^']|'\\'')+)'/)
  if (m) return m[1].replace(/'\\''/g, "'")
  return c.split(/\s+/)[0] || ''
}

/**
 * Does an installed hook command start a Node.js that exists? `{ ok, node, byName }`.
 * @param {unknown} cmd
 */
export function checkCommandNode(cmd) {
  const node = commandNode(cmd)
  if (!node || node === 'node' || node === 'node.exe') return { ok: false, node, byName: true }
  let ok = false
  try { ok = fs.statSync(node).isFile() } catch { /* gone */ }
  return { ok, node, byName: false }
}
