// @ts-check
// Codex CLI adapter (plan §3.3, §4). Hooks live in $CODEX_HOME/hooks.json (default ~/.codex). Install MERGES our entries
// into the user's file (a copy is kept once as hooks.json.hinty-agents.bak) and uninstall removes only them; nothing else
// in the file or in config.toml is touched. Codex runs non-managed hooks only after the person trusts them: type /hooks
// in Codex once after installing (trust is tied to the hook's hash and stored by Codex itself).
//
// Permission prompts: the PermissionRequest hook (caps.perm 'prompt-only'): allow / deny, no decision = Codex asks in the
// terminal. Session state: SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd.
// Instructions (`say`): `codex queue --thread <id> --message <text>` (Codex 0.171+; checked live: a running TUI shows it
// as the person's next message, also when the session sits idle at the prompt). Fallback for Codex without `queue`: the
// Stop hook is held while away mode is on and answered with {"decision":"block","reason":<text>} (caps.say 'stop-hold').
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hooksDir, installScripts, q } from './hookfiles.js'
import { isAbsPath, parseShim, runSync, start } from '../exec.js'

export const id = 'codex'
export const caps = { perm: 'prompt-only', say: 'queue' } // say: `codex queue`; fallback 'stop-hold' (Codex before 0.171)
export const BAK = 'hooks.json.hinty-agents.bak'
export const MARKER = 'codex-hook.cjs'

/**
 * Events we register: [Codex event, hook timeout in seconds]. Timeouts follow Codex's limits (SessionEnd: max 3 s).
 * @type {Array<[string, number]>}
 */
export const EVENTS = [
  ['SessionStart', 10],
  ['UserPromptSubmit', 10],
  ['PermissionRequest', 600],
  ['PostToolUse', 10],
  ['Stop', 600],
  ['SessionEnd', 2],
]

export const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
export const hooksFile = () => path.join(codexHome(), 'hooks.json')

/** @param {string} p */
const exists = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }

/**
 * How to start Codex WITHOUT a shell (the text of an instruction goes into argv, so a shell would be an injection risk).
 * HINTY_AGENTS_CODEX = a codex executable, an npm shim (.cmd) or codex.js; otherwise `codex` is looked up on PATH.
 * An npm shim (codex.cmd) is mapped to node + its codex.js. Returns null when nothing safe is found.
 * @returns {{ cmd: string, prefix: string[] } | null}
 */
export function resolveLaunch() {
  /** @param {string} p */
  const norm = (p) => {
    if (/\.js$/i.test(p)) return exists(p) ? { cmd: process.execPath, prefix: [p] } : null
    if (/\.(cmd|bat)$/i.test(p)) {
      const js = path.join(path.dirname(p), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      if (exists(js)) return { cmd: process.execPath, prefix: [js] }
      try { return exists(p) ? parseShim(p, fs.readFileSync(p, 'utf8')) : null } catch { return null }
    }
    return exists(p) ? { cmd: p, prefix: [] } : null
  }
  // an override must be an absolute path; PATH entries that are empty or relative (= the current folder) are skipped
  const forced = process.env.HINTY_AGENTS_CODEX
  if (forced) return isAbsPath(forced) ? norm(forced) : null
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']
  for (let dir of String(process.env.PATH || '').split(path.delimiter)) {
    dir = dir.trim().replace(/^"(.*)"$/, '$1')
    if (!isAbsPath(dir)) continue
    for (const n of names) {
      const hit = norm(path.join(dir, n))
      if (hit) return hit
    }
  }
  return null
}

/**
 * @param {string[]} args @param {{ timeoutMs?: number }} [o]
 * @returns {{ ok: boolean, code: number | null, stdout: string, stderr: string, missing: boolean }}
 */
export function run(args, o = {}) {
  const launch = resolveLaunch()
  if (!launch) return { ok: false, code: null, stdout: '', stderr: 'codex not found', missing: true }
  const r = runSync(launch, args, { encoding: 'utf8', timeout: o.timeoutMs ?? 60000, stdio: ['ignore', 'pipe', 'pipe'] })
  return { ok: r.status === 0, code: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), missing: !!r.error && /** @type {any} */ (r.error).code === 'ENOENT' }
}

/** @returns {{ found: boolean, version: string | null }} */
export function detect() {
  const r = run(['--version'], { timeoutMs: 30000 })
  if (!r.ok) return { found: false, version: null }
  const m = r.stdout.match(/(\d+\.\d+\.\d+)/)
  return { found: true, version: m ? m[1] : r.stdout.trim().slice(0, 40) }
}

/** Does this Codex have `codex queue` (0.171.0 and later)? */
export function queueSupported() {
  const r = run(['queue', '--help'], { timeoutMs: 30000 })
  return r.ok && /--thread/.test(r.stdout)
}

/**
 * Hand an instruction to a running (or idle) session: `codex queue --thread <id> --message <text>`. The TUI shows it as
 * the person's next message (checked live in 0.171.0, also while the session sits idle at the prompt). No shell; the
 * values are passed as --opt=value so a leading dash cannot become an option.
 * @param {string} sid @param {string} text @param {string} [home] CODEX_HOME of that session
 * @returns {Promise<boolean>}
 */
export function queueMessage(sid, text, home) {
  const launch = resolveLaunch()
  if (!launch) return Promise.resolve(false)
  return new Promise((resolve) => {
    let done = false
    const finish = (/** @type {boolean} */ v) => { if (!done) { done = true; resolve(v) } }
    try {
      const child = start(launch, ['queue', `--thread=${sid}`, `--message=${text}`], {
        env: home ? { CODEX_HOME: home } : {}, stdio: ['ignore', 'ignore', 'ignore'],
      })
      const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } finish(false) }, 30000)
      child.on('error', () => { clearTimeout(timer); finish(false) })
      child.on('close', (code) => { clearTimeout(timer); finish(code === 0) })
    } catch { finish(false) }
  })
}

/** @param {string} event */
export const commandFor = (event) => `node ${q(path.join(hooksDir(), 'codex-hook.cjs'))} ${event}`

/** @param {any} h a handler from hooks.json */
const isOurs = (h) => !!h && typeof h === 'object' && typeof h.command === 'string' && h.command.includes(MARKER)

/**
 * Remove our entries from a parsed hooks.json (pure). Other entries and keys are kept as they are.
 * @param {any} cfg @returns {any}
 */
export function strip(cfg) {
  const out = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? JSON.parse(JSON.stringify(cfg)) : {}
  const hooks = out.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return out
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue
    hooks[ev] = hooks[ev]
      .map((/** @type {any} */ g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((/** @type {any} */ h) => !isOurs(h)) } : g))
      .filter((/** @type {any} */ g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0))
    if (!hooks[ev].length) delete hooks[ev]
  }
  if (!Object.keys(hooks).length) delete out.hooks
  return out
}

/**
 * Add our entries to a parsed hooks.json (pure, idempotent: ours are removed first).
 * @param {any} cfg @returns {any}
 */
export function merge(cfg) {
  const out = strip(cfg)
  if (!out.hooks) out.hooks = {}
  for (const [event, timeout] of EVENTS) {
    const list = Array.isArray(out.hooks[event]) ? out.hooks[event] : []
    list.push({ hooks: [{ type: 'command', command: commandFor(event), timeout }] })
    out.hooks[event] = list
  }
  return out
}

/** @returns {{ file: string, exists: boolean, cfg: any, error: string | null }} */
function readHooks() {
  const file = hooksFile()
  if (!fs.existsSync(file)) return { file, exists: false, cfg: {}, error: null }
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { file, exists: true, cfg: null, error: 'hooks.json is not a JSON object' }
    return { file, exists: true, cfg, error: null }
  } catch (e) {
    return { file, exists: true, cfg: null, error: `hooks.json is not valid JSON (${/** @type {Error} */ (e).message})` }
  }
}

/** Warnings about the rest of the Codex setup (read-only look at config.toml). @returns {string[]} */
export function configNotes() {
  const notes = []
  try {
    const toml = fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8')
    if (/^\s*\[hooks[\].]/m.test(toml) && !/^\s*\[hooks\.state/m.test(toml)) {
      notes.push('config.toml also declares [hooks]: Codex warns when one layer uses both formats; keep Hinty in hooks.json only')
    }
    if (/^\s*hooks\s*=\s*false/m.test(toml) || /^\s*codex_hooks\s*=\s*false/m.test(toml)) {
      notes.push('config.toml turns hooks off ([features] hooks = false): Hinty hooks will not run')
    }
  } catch { /* no config.toml */ }
  return notes
}

/** @returns {{ ok: boolean, steps: Array<{ step: string, ok: boolean, message: string }> }} */
export function install() {
  const steps = []
  const r = readHooks()
  if (r.error) {
    steps.push({ step: 'hooks.json', ok: false, message: `${r.error}; left untouched (${r.file})` })
    return { ok: false, steps }
  }
  const dir = installScripts()
  steps.push({ step: 'hook scripts', ok: true, message: dir })
  fs.mkdirSync(codexHome(), { recursive: true })
  const bak = path.join(codexHome(), BAK)
  if (r.exists && !fs.existsSync(bak)) {
    fs.copyFileSync(r.file, bak)
    steps.push({ step: 'backup', ok: true, message: `copy of your hooks.json: ${bak}` })
  }
  fs.writeFileSync(r.file, JSON.stringify(merge(r.cfg), null, 2) + '\n')
  steps.push({ step: 'hooks.json', ok: true, message: `${EVENTS.length} hooks added to ${r.file}` })
  for (const n of configNotes()) steps.push({ step: 'note', ok: true, message: n })
  steps.push({ step: 'trust', ok: true, message: 'Codex does not run new hooks until you trust them: at its next start it shows "Hooks need review", choose "Trust all and continue" (or review them later with /hooks)' })
  return { ok: true, steps }
}

/** @returns {{ ok: boolean, steps: Array<{ step: string, ok: boolean, message: string }> }} */
export function uninstall() {
  const steps = []
  const r = readHooks()
  if (!r.exists) {
    steps.push({ step: 'hooks.json', ok: true, message: 'no hooks.json: nothing to remove' })
    return { ok: true, steps }
  }
  if (r.error) {
    steps.push({ step: 'hooks.json', ok: false, message: `${r.error}; left untouched (${r.file})` })
    return { ok: false, steps }
  }
  const next = strip(r.cfg)
  const onlyEmpty = Object.keys(next).every((k) => k === 'hooks' || k === 'description') && !next.hooks
  if (onlyEmpty && !fs.existsSync(path.join(codexHome(), BAK))) {
    fs.unlinkSync(r.file)
    steps.push({ step: 'hooks.json', ok: true, message: `removed ${r.file} (it held only Hinty hooks)` })
  } else {
    fs.writeFileSync(r.file, JSON.stringify(next, null, 2) + '\n')
    steps.push({ step: 'hooks.json', ok: true, message: `Hinty hooks removed from ${r.file}` })
  }
  return { ok: true, steps }
}

/** @returns {{ installed: boolean, complete: boolean, events: string[], file: string, error: string | null }} */
export function installed() {
  const r = readHooks()
  const events = []
  if (r.cfg && r.cfg.hooks && typeof r.cfg.hooks === 'object') {
    for (const [ev] of EVENTS) {
      const groups = Array.isArray(r.cfg.hooks[ev]) ? r.cfg.hooks[ev] : []
      if (groups.some((/** @type {any} */ g) => g && Array.isArray(g.hooks) && g.hooks.some(isOurs))) events.push(ev)
    }
  }
  return { installed: events.length > 0, complete: events.length === EVENTS.length, events, file: r.file, error: r.error }
}

/**
 * Codex hook input -> the service's common shape. Pure. Returns null for input the service must ignore.
 * @param {unknown} input
 * @returns {{ sid: string, cwd: string, tool: string, input: unknown, text: string, source: string, stopActive: boolean, agentId: string | null, agentType: string, home: string } | null}
 */
export function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const o = /** @type {Record<string, any>} */ (input)
  if (typeof o.session_id !== 'string') return null
  return {
    sid: o.session_id,
    cwd: typeof o.cwd === 'string' ? o.cwd : '',
    tool: typeof o.tool_name === 'string' && o.tool_name ? o.tool_name : 'tool',
    input: o.tool_input,
    text: typeof o.last_assistant_message === 'string' ? o.last_assistant_message : '',
    source: typeof o.source === 'string' ? o.source : '',
    stopActive: o.stop_hook_active === true,
    agentId: typeof o.agent_id === 'string' && o.agent_id ? o.agent_id : null,
    agentType: typeof o.agent_type === 'string' ? o.agent_type : '',
    home: typeof o.hinty_codex_home === 'string' ? o.hinty_codex_home.slice(0, 500) : '',
  }
}
