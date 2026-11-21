// @ts-check
// Starting other programs safely (security review point 6). On Windows `cmd.exe` and libuv look for a program given by
// bare name in the CURRENT folder first, so `npx hinty-agents doctor` typed in a terminal open in somebody's repository
// could run that repository's `claude.cmd`. So:
//  - `hardenEnv()` sets NoDefaultCurrentDirectoryInExePath=1 for this process and every child (CLI and service call it
//    first thing);
//  - programs are found by our own PATH lookup (`which`): absolute PATH entries only, never the current folder;
//  - nothing is started through a shell. An npm `.cmd` shim (which Node will not start without a shell) is read and
//    mapped to what it starts: node + the script, or the .exe;
//  - system tools are called by full path (`sysExe`), helper processes start in the home folder.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const WIN = process.platform === 'win32'

export function hardenEnv() {
  if (WIN) process.env.NoDefaultCurrentDirectoryInExePath = '1'
}

/** Full path of a Windows system tool (icacls.exe, taskkill.exe, ...). @param {string} name */
export const sysExe = (name) => path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', name)
export const powershellExe = () => sysExe(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe'))

/**
 * An absolute path in the platform's own sense: `C:\...`, `C:/...` or `\\server\share` on Windows, `/...` elsewhere.
 * `C:foo` and `\foo` (relative to a drive or the current drive) do not count.
 * @param {unknown} p
 */
export function isAbsPath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return false
  return WIN ? /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/]/.test(p) : p.startsWith('/')
}

/** @param {string} p */
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }

/**
 * Our own PATH lookup: absolute entries only (an empty or relative entry would mean the current folder).
 * @param {string} name e.g. `claude`, `npm`
 * @param {{ path?: string }} [o]
 * @returns {string | null} absolute path
 */
export function which(name, o = {}) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return null
  const exts = WIN ? ['.exe', '.cmd', '.bat', '.com'] : ['']
  for (let dir of String(o.path ?? process.env.PATH ?? '').split(path.delimiter)) {
    dir = dir.trim().replace(/^"(.*)"$/, '$1')
    if (!isAbsPath(dir)) continue
    for (const ext of exts) {
      const p = path.join(dir, name + ext)
      if (isFile(p)) return p
    }
  }
  return null
}

/**
 * What an npm-style `.cmd` shim starts: `node <script>` or an `.exe`. Pure on the text (exported for tests).
 * @param {string} file the shim @param {string} text its content
 * @returns {{ cmd: string, prefix: string[] } | null}
 */
export function parseShim(file, text) {
  const dir = path.dirname(file)
  const lines = String(text).split(/\r?\n/)
  /** @type {Record<string, string>} */
  const vars = {}
  const rel = (/** @type {string} */ s) => {
    const m = s.match(/^%~?dp0%?[\\/]*(.+)$/i)
    return m ? path.join(dir, m[1]) : null
  }
  for (const l of lines) {
    const m = l.match(/SET\s+"([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"/i)
    if (m && /^%~?dp0/i.test(m[2])) vars[m[1].toUpperCase()] = m[2]
  }
  const run = lines.filter((l) => l.includes('%*'))
  for (const l of run) {
    const quoted = [...l.matchAll(/"([^"]+)"/g)].map((x) => x[1])
    for (let q of quoted) {
      const v = q.match(/^%([A-Za-z_][A-Za-z0-9_]*)%$/)
      if (v && vars[v[1].toUpperCase()]) q = vars[v[1].toUpperCase()]
      const p = rel(q)
      if (!p || /(^|[\\/])node\.exe$/i.test(p)) continue
      if (/\.(c|m)?js$/i.test(p) && isFile(p)) return { cmd: process.execPath, prefix: [p] }
      if (/\.exe$/i.test(p) && isFile(p)) return { cmd: p, prefix: [] }
    }
  }
  return null
}

/**
 * How to start this file without a shell.
 * @param {string} file absolute path @returns {{ cmd: string, prefix: string[] } | null}
 */
export function launchFor(file) {
  if (!isAbsPath(file) || !isFile(file)) return null
  if (/\.(c|m)?js$/i.test(file)) return { cmd: process.execPath, prefix: [file] }
  if (/\.(cmd|bat)$/i.test(file)) {
    try { return parseShim(file, fs.readFileSync(file, 'utf8')) } catch { return null }
  }
  return { cmd: file, prefix: [] }
}

/**
 * A program by name (own PATH lookup) or by an override that must be an absolute path (test hooks such as
 * HINTY_AGENTS_GROK; a relative override is ignored, never resolved against the current folder).
 * @param {string} name @param {string | undefined} [override]
 */
export function resolveProgram(name, override) {
  if (override) return isAbsPath(override) ? launchFor(override) : null
  const f = which(name)
  return f ? launchFor(f) : null
}

/** Environment for a helper process: ours (already hardened) plus extra values. @param {Record<string, string>} [extra] */
export const childEnv = (extra = {}) => ({ ...process.env, ...(WIN ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}), ...extra })

/**
 * spawnSync without a shell, in the home folder.
 * @param {{ cmd: string, prefix: string[] }} launch @param {string[]} args @param {import('node:child_process').SpawnSyncOptions} [opts]
 */
export function runSync(launch, args, opts = {}) {
  return spawnSync(launch.cmd, [...launch.prefix, ...args], { windowsHide: true, cwd: os.homedir(), ...opts, env: childEnv(/** @type {any} */ (opts.env) || {}), shell: false })
}

/**
 * spawn without a shell, in the home folder.
 * @param {{ cmd: string, prefix: string[] }} launch @param {string[]} args @param {import('node:child_process').SpawnOptions} [opts]
 */
export function start(launch, args, opts = {}) {
  return spawn(launch.cmd, [...launch.prefix, ...args], { windowsHide: true, cwd: os.homedir(), ...opts, env: childEnv(/** @type {any} */ (opts.env) || {}), shell: false })
}

/** npm without a shell: the npm-cli.js next to this Node first (standard on Windows), else `npm` from PATH. */
export function npmLaunch() {
  const bundled = WIN
    ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (isFile(bundled)) return { cmd: process.execPath, prefix: [bundled] }
  return resolveProgram('npm')
}

/**
 * The command line of a process, or null when it cannot be read (used to make sure a pid is our service before
 * `stop` kills it or a lock is respected).
 * @param {number} pid @returns {string | null}
 */
export function processCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim() || null
    if (WIN) {
      const r = spawnSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
      { encoding: 'utf8', windowsHide: true, timeout: 15000, cwd: os.homedir(), env: childEnv() })
      return r.status === 0 ? String(r.stdout || '').trim() || null : null
    }
    const r = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 10000, cwd: os.homedir() })
    return r.status === 0 ? String(r.stdout || '').trim() || null : null
  } catch { return null }
}

/** Does this command line belong to a hinty-agents service (`node .../bin/hinty-agents.js daemon`)? @param {string | null} line */
export const isOurDaemonLine = (line) => !!line && /hinty-agents(\.js)?["']?\s+daemon(\s|$)/i.test(line)
