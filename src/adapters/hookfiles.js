// @ts-check
// The hook scripts of the Codex and Grok adapters live in ~/.hinty-agents/hooks/ (a stable path: an `npx` cache folder
// may be cleaned later, and the agents' hook files point to these copies). Install copies them, uninstall of the last
// adapter that uses them leaves them (they are tiny and harmless without a hook entry).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { activeRoot } from '../root.js'
import { childEnv, powershellExe, sysExe, which } from '../exec.js'
import { ensureHome, homeDir } from '../store.js'

export const SCRIPTS = ['common.cjs', 'codex-hook.cjs', 'grok-hook.cjs']

export const sourceDir = () => path.join(activeRoot(), 'hooks')
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

/** @param {string} p a Windows path written with forward slashes (cmd.exe, PowerShell and sh all read that form) */
const fwd = (p) => (WIN ? p.replace(/\\/g, '/') : p)

/** @param {string} exe */
function nodeCommandUncached(exe) {
  if (BARE.test(exe)) return fwd(exe)
  if (WIN) {
    const s = shortPath(exe)
    if (s && BARE.test(s)) return fwd(s)
    // a path with spaces on a drive without 8.3 names: works in cmd.exe only (install and doctor say so)
    return `@"${fwd(exe).replace(/"/g, '')}"`
  }
  return `'${exe.replace(/'/g, "'\\''")}'`
}

/** Does this hook command start Node in a form only cmd.exe reads (`@"..."`)? @param {string} [exe] */
export const cmdOnlyNode = (exe = nodeExe()) => nodeCommand(exe).startsWith('@"')

/** the Node part of a command in a form this installer writes: a bare path, `@"..."` (cmd.exe) or `'...'` (sh) */
const NODE_PART = /^(?:[A-Za-z0-9_:\\/.+~-]+|@"[^"%^&|<>!]+"|'(?:[^']|'\\'')+')/

/**
 * The probe of an installed hook command (security review 3, P3): the same command with its event replaced by
 * `--ping`; the hook script then prints `{"hinty":"pong",...}` without reading anything or calling the service.
 * Only a command of exactly the form `install` writes (Node, our script in the data folder, an event and an optional
 * number) is ever run; anything else (an edited hooks file) gives null, so `doctor` never runs what the agent's own
 * hook review has not seen. Pure.
 * @param {unknown} cmd @param {string} script e.g. `codex-hook.cjs` @param {string} [hookPath] default: the data folder's copy
 */
export function pingCommand(cmd, script, hookPath = path.join(hooksDir(), script)) {
  const c = String(cmd || '')
  const m = c.match(NODE_PART)
  const hook = q(hookPath)
  if (!m || !c.startsWith(` ${hook} `, m[0].length)) return null
  if (!/^[A-Za-z]{1,40}(?: \d{1,5})?$/.test(c.slice(m[0].length + hook.length + 2))) return null
  return `${m[0]} ${hook} --ping`
}

/** @typedef {{ shell: string, ok: boolean, why: string }} ShellRun */

/**
 * Run a hook probe the ways an agent may start it: cmd.exe (`/d /s /c`, as Node's shell:true does) and PowerShell on
 * Windows, plus `sh` when one is on PATH (Git for Windows); `/bin/sh -c` elsewhere. Started in the home folder, no
 * input. `ok` = the hook answered `pong`.
 * @param {string} probe @param {string} hook `codex` | `grok`
 * @returns {ShellRun[]}
 */
export function runProbe(probe, hook) {
  const opts = { encoding: /** @type {const} */ ('utf8'), windowsHide: true, timeout: 20000, cwd: os.homedir(), env: childEnv(), input: '' }
  /** @param {string} shell @param {import('node:child_process').SpawnSyncReturns<string>} r */
  const judge = (shell, r) => {
    const outText = String(r.stdout || '')
    let ok = false
    try { const j = JSON.parse(outText.trim()); ok = !!j && j.hinty === 'pong' && j.hook === hook } catch { /* not the answer */ }
    const err = String(r.stderr || '').trim().split(/\r?\n/)[0] || (r.error ? r.error.message : `exit ${r.status}`)
    return { shell, ok, why: ok ? '' : err.slice(0, 120) }
  }
  /** @type {ShellRun[]} */
  const out = []
  if (WIN) {
    out.push(judge('cmd.exe', spawnSync(sysExe('cmd.exe'), ['/d', '/s', '/c', `"${probe}"`], { ...opts, windowsVerbatimArguments: true })))
    out.push(judge('PowerShell', spawnSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', probe], opts)))
    const sh = which('sh')
    if (sh) out.push(judge('sh', spawnSync(sh, ['-c', probe], opts)))
  } else {
    out.push(judge('sh', spawnSync('/bin/sh', ['-c', probe], opts)))
  }
  return out
}

/**
 * Probe the installed hook command of an agent; `{ ok, runs, text }`: ok = at least one shell starts it (null when
 * there is nothing to probe). The text names the shells it does not start in.
 * @param {unknown} cmd the installed command @param {'codex' | 'grok'} hook
 * @returns {{ ok: boolean | null, runs: ShellRun[], text: string }}
 */
export function probeHook(cmd, hook) {
  const probe = pingCommand(cmd, `${hook}-hook.cjs`)
  if (!probe) return { ok: false, runs: [], text: 'hook command is not in the form install writes (not run)' }
  const runs = runProbe(probe, hook)
  const good = runs.filter((r) => r.ok).map((r) => r.shell)
  const bad = runs.filter((r) => !r.ok)
  const text = !bad.length ? `hook command starts in ${good.join(', ')}`
    : good.length ? `hook command starts in ${good.join(', ')}, NOT in ${bad.map((r) => `${r.shell} (${r.why})`).join(', ')}`
      : `hook command does not start in any shell: ${bad.map((r) => `${r.shell} (${r.why})`).join(', ')}`
  return { ok: good.length > 0, runs, text }
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
