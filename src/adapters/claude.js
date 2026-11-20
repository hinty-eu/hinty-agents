// @ts-check
// Claude Code adapter (plan §4 "AgentAdapter"). Install and uninstall use Claude Code's own plugin commands: this
// repository is a plugin marketplace (.claude-plugin/marketplace.json) and the plugin lives in ./claude-plugin
// (hooks + mod). Nothing is written into the user's settings by hand (plan D7).
//
// Permission prompts come through the PermissionRequest hook (caps.perm 'prompt-only'); instructions reach a session
// through the mod's $.prompt.submit (caps.say 'mod'). TODO (route 2, plan §4.2): when mods are disabled
// (`disableAllHooks`, `allowManagedModsOnly`), hold the Stop hook in away mode and hand the instruction over as
// `hookSpecificOutput.additionalContext` (not `decision: block`, which shows "Stop hook error"); limit 8 in a row.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const id = 'claude'
export const PLUGIN = 'hinty-agents'
export const MARKETPLACE = 'hinty-agents'
export const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`
export const caps = { perm: 'prompt-only', say: 'mod' }

export const repoRoot = () => path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
export const pluginDir = () => path.join(repoRoot(), 'claude-plugin')

/** @param {string} a */
const quoteWin = (a) => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)

/**
 * Run `claude` (always with DISABLE_AUTOUPDATER=1: an update interrupted mid-way breaks the CLI).
 * @param {string[]} args @param {{ timeoutMs?: number }} [o]
 * @returns {{ ok: boolean, code: number | null, stdout: string, stderr: string, missing: boolean }}
 */
export function run(args, o = {}) {
  const win = process.platform === 'win32'
  const env = { ...process.env, DISABLE_AUTOUPDATER: '1' }
  const r = win
    ? spawnSync(['claude', ...args].map(quoteWin).join(' '), { shell: true, env, encoding: 'utf8', timeout: o.timeoutMs ?? 120000, windowsHide: true })
    : spawnSync('claude', args, { env, encoding: 'utf8', timeout: o.timeoutMs ?? 120000 })
  const stderr = String(r.stderr || '')
  const missing = !!r.error && /** @type {any} */ (r.error).code === 'ENOENT' ||
    (win && r.status !== 0 && /is not recognized|nie jest rozpoznawane/i.test(stderr))
  return { ok: r.status === 0, code: r.status, stdout: String(r.stdout || ''), stderr, missing }
}

/** @param {string} out */
function lastJson(out) {
  const lines = out.trim().split(/\r?\n/).reverse()
  for (const l of lines) { try { return JSON.parse(l) } catch { /* not JSON */ } }
  try { return JSON.parse(out) } catch { return null }
}

/** @returns {{ found: boolean, version: string | null }} */
export function detect() {
  const r = run(['--version'], { timeoutMs: 30000 })
  if (!r.ok) return { found: false, version: null }
  const m = r.stdout.match(/(\d+\.\d+\.\d+)/)
  return { found: true, version: m ? m[1] : r.stdout.trim().slice(0, 40) }
}

/** @returns {{ ok: boolean, steps: Array<{ step: string, ok: boolean, message: string }> }} */
export function install() {
  const steps = []
  const add = run(['plugin', 'marketplace', 'add', repoRoot(), '--scope', 'user', '--json'])
  const a = lastJson(add.stdout)
  steps.push({ step: 'marketplace add', ok: add.ok, message: a?.message || add.stderr.trim().slice(0, 300) })
  if (!add.ok) return { ok: false, steps }
  const inst = run(['plugin', 'install', PLUGIN_ID, '--scope', 'user', '--json'])
  const i = lastJson(inst.stdout)
  steps.push({ step: 'install', ok: inst.ok, message: i?.message || inst.stderr.trim().slice(0, 300) })
  return { ok: inst.ok, steps }
}

/** @returns {{ ok: boolean, steps: Array<{ step: string, ok: boolean, message: string }> }} */
export function uninstall() {
  const steps = []
  const un = run(['plugin', 'uninstall', PLUGIN_ID, '--scope', 'user', '--json'])
  const u = lastJson(un.stdout)
  const notInstalled = u?.failureCode === 'not_installed'
  steps.push({ step: 'uninstall', ok: un.ok || notInstalled, message: u?.message || un.stderr.trim().slice(0, 300) })
  const rm = run(['plugin', 'marketplace', 'remove', MARKETPLACE, '--json'])
  const m = lastJson(rm.stdout)
  const notConfigured = m?.failureCode === 'not_configured'
  steps.push({ step: 'marketplace remove', ok: rm.ok || notConfigured, message: m?.message || rm.stderr.trim().slice(0, 300) })
  return { ok: steps.every((s) => s.ok), steps }
}

/** @returns {{ installed: boolean, enabled: boolean, folder: string | null, version: string | null }} */
export function installed() {
  const r = run(['plugin', 'list', '--json'], { timeoutMs: 60000 })
  const list = lastJson(r.stdout)
  const e = Array.isArray(list) ? list.find((x) => x && x.id === PLUGIN_ID) : null
  return { installed: !!e, enabled: !!e?.enabled, folder: e?.readFromFolder || e?.installPath || null, version: e?.version || null }
}

/** @param {string} [dir] @returns {{ ok: boolean, errors: string[], notes: string[] }} */
export function validate(dir = pluginDir()) {
  const r = run(['plugin', 'validate', dir, '--json'], { timeoutMs: 60000 })
  const j = lastJson(r.stdout)
  const contents = Array.isArray(j?.contents) ? j.contents : []
  const errors = [...(j?.errors || []), ...contents.flatMap((/** @type {any} */ c) => c.errors || [])]
    .map((/** @type {any} */ e) => (typeof e === 'string' ? e : e.message || JSON.stringify(e)))
  const notes = contents.flatMap((/** @type {any} */ c) => c.notes || [])
  return { ok: r.ok && errors.length === 0, errors, notes }
}
