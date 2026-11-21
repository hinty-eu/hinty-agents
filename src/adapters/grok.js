// @ts-check
// Grok Build adapter (plan §3.3, E4). Hooks live in ~/.grok/hooks/*.json; we own one file, hinty.json (an existing file
// of that name that is not ours is copied to hinty.json.bak first). Source: docs.x.ai/build/features/hooks.
//
// What Grok gives us: 14 events, but ONLY `PreToolUse` can block (`{"decision":"deny","reason":...}` or exit 2) and
// hooks FAIL OPEN: a crash, a timeout or bad output lets the step run. Default hook timeout is 5 s. The output of the
// other events is ignored, so there is no way to inject context (the glasses line) or an instruction (`say`) into a Grok
// session: `say` is unsupported (caps.say 'none'). Session state comes from SessionStart / UserPromptSubmit / Stop /
// SessionEnd. Permission cards exist only with `install grok --ask-shell`; "Allow" then means "no veto" (Grok's own
// permission checks still apply), and when nobody answers in time the step runs.
//
// Not verified on a live Grok Build (the CLI needs a paid xAI account); see test/grok.test.js for the simulated inputs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readConfig } from '../store.js'
import { hooksDir, installScripts, q } from './hookfiles.js'

export const id = 'grok'
export const caps = { perm: 'veto-only', say: 'none' }
export const FILE = 'hinty.json'
export const MARKER = 'grok-hook.cjs'
/** How long the service waits for a card, seconds; the hook's own timeout is this plus 20 s. */
export const ASK_HOLD_S = 280

/** Shell commands that never get a card (each chained segment must match; see isExcepted). */
export const DEFAULT_EXCEPT = [
  'ls', 'dir', 'pwd', 'cd', 'cat', 'head', 'tail', 'wc', 'echo', 'which', 'where', 'whoami', 'date', 'type',
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git rev-parse', 'git remote -v',
  'node --version', 'node -v', 'npm --version', 'npm -v', 'npm ls', 'npm run test', 'npm test',
]

export const grokHome = () => process.env.HINTY_AGENTS_GROK_HOME || process.env.GROK_HOME || path.join(os.homedir(), '.grok')
export const hooksFile = () => path.join(grokHome(), 'hooks', FILE)

/** HINTY_AGENTS_GROK = path of the `grok` executable; default `grok` from PATH. */
const grokBin = () => process.env.HINTY_AGENTS_GROK || 'grok'
const quoteWin = (/** @type {string} */ p) => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(p) ? p : `"${p.replace(/"/g, '\\"')}"`)

/** @returns {{ found: boolean, version: string | null }} */
export function detect() {
  const win = process.platform === 'win32'
  const r = win
    ? spawnSync([grokBin(), '--version'].map(quoteWin).join(' '), { shell: true, encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawnSync(grokBin(), ['--version'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) return { found: false, version: null }
  const m = String(r.stdout || '').match(/(\d+\.\d+\.\d+)/)
  return { found: true, version: m ? m[1] : String(r.stdout || '').trim().slice(0, 40) }
}

/** @param {string} event @param {number} [holdS] */
export const commandFor = (event, holdS) =>
  `node ${q(path.join(hooksDir(), 'grok-hook.cjs'))} ${event}${holdS ? ` ${holdS}` : ''}`

/**
 * The content of hinty.json (pure).
 * @param {{ askShell?: boolean }} [o]
 */
export function buildConfig(o = {}) {
  /** @type {Record<string, any[]>} */
  const hooks = {}
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
    hooks[event] = [{ hooks: [{ type: 'command', command: commandFor(event), timeout: 5 }] }]
  }
  if (o.askShell) {
    hooks.PreToolUse = [{
      matcher: 'Bash|bash|Shell|shell|PowerShell|run_terminal_cmd|execute_command',
      hooks: [{ type: 'command', command: commandFor('PreToolUse', ASK_HOLD_S), timeout: ASK_HOLD_S + 20 }],
    }]
  }
  return { hooks }
}

/** @param {string} file */
function isOurFile(file) {
  try { return fs.readFileSync(file, 'utf8').includes(MARKER) } catch { return false }
}

/**
 * @param {{ askShell?: boolean }} [o]
 * @returns {{ ok: boolean, steps: Array<{ step: string, ok: boolean, message: string }> }}
 */
export function install(o = {}) {
  const steps = []
  const file = hooksFile()
  const dir = installScripts()
  steps.push({ step: 'hook scripts', ok: true, message: dir })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file) && !isOurFile(file)) {
    fs.copyFileSync(file, `${file}.bak`)
    steps.push({ step: 'backup', ok: true, message: `an existing ${FILE} was not ours; copy kept as ${file}.bak` })
  }
  fs.writeFileSync(file, JSON.stringify(buildConfig(o), null, 2) + '\n')
  steps.push({ step: 'hooks', ok: true, message: `${file}${o.askShell ? ' (with --ask-shell)' : ''}` })
  steps.push({
    step: 'trust', ok: true,
    message: 'personal hooks (~/.grok/hooks) are read at the next Grok session; check /hooks in Grok\'s extensions modal',
  })
  if (o.askShell) {
    steps.push({
      step: 'WARNING', ok: true,
      message: 'Grok fails OPEN: if the Hinty hook crashes, times out or the service is down, Grok RUNS the step. ' +
        '"Allow" on the glasses only means "no veto"; Grok\'s own permission prompts still apply.',
    })
  }
  return { ok: true, steps }
}

/** @returns {{ ok: boolean, steps: Array<{ step: string, ok: boolean, message: string }> }} */
export function uninstall() {
  const file = hooksFile()
  if (!fs.existsSync(file)) return { ok: true, steps: [{ step: 'hooks', ok: true, message: `no ${FILE}: nothing to remove` }] }
  if (!isOurFile(file)) {
    return { ok: false, steps: [{ step: 'hooks', ok: false, message: `${file} is not a Hinty file; left untouched` }] }
  }
  fs.unlinkSync(file)
  const steps = [{ step: 'hooks', ok: true, message: `removed ${file}` }]
  const bak = `${file}.bak`
  if (fs.existsSync(bak)) {
    fs.renameSync(bak, file)
    steps.push({ step: 'restore', ok: true, message: `restored your earlier ${FILE}` })
  }
  return { ok: true, steps }
}

/** @returns {{ installed: boolean, askShell: boolean, file: string }} */
export function installed() {
  const file = hooksFile()
  if (!isOurFile(file)) return { installed: false, askShell: false, file }
  let askShell = false
  try { askShell = !!JSON.parse(fs.readFileSync(file, 'utf8'))?.hooks?.PreToolUse } catch { /* unreadable */ }
  return { installed: true, askShell, file }
}

/** Is ask-shell on (installed with --ask-shell)? */
export const askShellOn = () => installed().askShell

/** The exception list: DEFAULT_EXCEPT, or the person's own in ~/.hinty-agents/config.json -> grok.except. @returns {string[]} */
export function exceptions() {
  const own = /** @type {any} */ (readConfig())?.grok?.except
  return Array.isArray(own) && own.every((x) => typeof x === 'string') ? own : DEFAULT_EXCEPT
}

/**
 * Is this shell command harmless enough to skip the card? Every chained segment must start with an exception (whole
 * words), and no substitution, redirection or newline is allowed anywhere. Pure.
 * @param {string} command @param {string[]} list
 */
export function isExcepted(command, list = DEFAULT_EXCEPT) {
  const c = String(command || '').trim()
  if (!c || /[`<>\n\r]|\$\(|\$\{/.test(c)) return false
  const segments = c.split(/&&|\|\||;|\|/).map((s) => s.trim())
  if (!segments.length || segments.some((s) => !s)) return false
  return segments.every((seg) => list.some((p) => seg === p || seg.startsWith(`${p} `)))
}

/** Does this tool name look like a shell? (the exact name Grok uses is not documented) @param {string} name */
export const isShellTool = (name) => /^(bash|powershell|shell|run_?terminal(_cmd)?|execute(_command)?|exec|run_?command)$/i.test(String(name || ''))

/**
 * Grok hook input (camelCase) -> the service's common shape. Pure.
 * @param {unknown} input
 * @returns {{ sid: string, cwd: string, tool: string, input: unknown, text: string, source: string, stopActive: boolean, agentId: string | null, agentType: string, home: string } | null}
 */
export function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const o = /** @type {Record<string, any>} */ (input)
  const sid = typeof o.sessionId === 'string' ? o.sessionId : typeof o.session_id === 'string' ? o.session_id : null
  if (!sid) return null
  const text = [o.lastAssistantMessage, o.last_assistant_message, o.message].find((x) => typeof x === 'string') || ''
  return {
    sid,
    cwd: typeof o.cwd === 'string' ? o.cwd : typeof o.workspaceRoot === 'string' ? o.workspaceRoot : '',
    tool: typeof o.toolName === 'string' && o.toolName ? o.toolName : typeof o.tool_name === 'string' && o.tool_name ? o.tool_name : 'tool',
    input: o.toolInput ?? o.tool_input,
    text,
    source: typeof o.source === 'string' ? o.source : '',
    stopActive: false,
    agentId: null,
    agentType: '',
    home: '',
  }
}
