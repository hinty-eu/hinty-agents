// @ts-check
// Claude Code adapter (plan §4 "AgentAdapter"). Install and uninstall use Claude Code's own plugin commands: this
// repository is a plugin marketplace (.claude-plugin/marketplace.json) and the plugin lives in ./claude-plugin
// (hooks + mod). Nothing is written into the user's settings by hand (plan D7).
//
// Permission prompts come through the PermissionRequest hook (caps.perm 'prompt-only'); instructions reach a session
// through the mod's $.prompt.submit (caps.say 'mod'). TODO (route 2, plan §4.2): when mods are disabled
// (`disableAllHooks`, `allowManagedModsOnly`), hold the Stop hook in away mode and hand the instruction over as
// `hookSpecificOutput.additionalContext` (not `decision: block`, which shows "Stop hook error"); limit 8 in a row.
import path from 'node:path'
import { activeRoot } from '../root.js'
import { resolveProgram, runSync } from '../exec.js'

export const id = 'claude'
export const PLUGIN = 'hinty-agents'
export const MARKETPLACE = 'hinty-agents'
export const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`
export const caps = { perm: 'prompt-only', say: 'mod' }

export const repoRoot = () => activeRoot()
export const pluginDir = () => path.join(repoRoot(), 'claude-plugin')

/**
 * Run `claude` (always with DISABLE_AUTOUPDATER=1: an update interrupted mid-way breaks the CLI). Found by our own PATH
 * lookup (never the current folder) and started without a shell (security review point 6); an npm shim is mapped to
 * what it starts. HINTY_AGENTS_CLAUDE = an absolute path of another `claude` (tests).
 * @param {string[]} args @param {{ timeoutMs?: number }} [o]
 * @returns {{ ok: boolean, code: number | null, stdout: string, stderr: string, missing: boolean }}
 */
export function run(args, o = {}) {
  const launch = resolveProgram('claude', process.env.HINTY_AGENTS_CLAUDE)
  if (!launch) return { ok: false, code: null, stdout: '', stderr: 'claude not found', missing: true }
  const r = runSync(launch, args, { env: { DISABLE_AUTOUPDATER: '1' }, encoding: 'utf8', timeout: o.timeoutMs ?? 120000, stdio: ['ignore', 'pipe', 'pipe'] })
  const missing = !!r.error && /** @type {any} */ (r.error).code === 'ENOENT'
  return { ok: r.status === 0, code: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), missing }
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
  // A directory plugin loads in place from the marketplace folder (our stable copy). Re-adding the marketplace pointed it
  // at the new copy; an already installed plugin only learns the new version through `plugin update`.
  if (inst.ok && i && i.installedVersion && i.availableVersion && i.installedVersion !== i.availableVersion) {
    const up = run(['plugin', 'update', PLUGIN_ID, '--scope', 'user', '--json'])
    const u = lastJson(up.stdout)
    steps.push({ step: 'update', ok: up.ok, message: u?.message || up.stderr.trim().slice(0, 300) })
    return { ok: up.ok, steps }
  }
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
