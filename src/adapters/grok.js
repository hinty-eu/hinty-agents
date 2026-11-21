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
import { resolveProgram, runSync } from '../exec.js'
import { readConfig } from '../store.js'
import { checkCommandNode, cmdOnlyNode, hooksDir, installScripts, nodeCommand, probeHook, q } from './hookfiles.js'

export const id = 'grok'
export const caps = { perm: 'veto-only', say: 'none' }
export const FILE = 'hinty.json'
export const MARKER = 'grok-hook.cjs'
/** How long the service waits for a card, seconds; the hook's own timeout is this plus 20 s. */
export const ASK_HOLD_S = 280

/**
 * Shell commands that never get a card (see isExcepted). Since the security review (point 9) without `npm test` /
 * `npm run test` (they run a script the agent can edit) and `git branch` (`-D` deletes).
 */
export const DEFAULT_EXCEPT = [
  'ls', 'dir', 'pwd', 'cd', 'cat', 'head', 'tail', 'wc', 'echo', 'which', 'where', 'whoami', 'date', 'type',
  'git status', 'git diff', 'git log', 'git show', 'git rev-parse', 'git remote -v',
  'node --version', 'node -v', 'npm --version', 'npm -v', 'npm ls',
]

export const grokHome = () => process.env.HINTY_AGENTS_GROK_HOME || process.env.GROK_HOME || path.join(os.homedir(), '.grok')
export const hooksFile = () => path.join(grokHome(), 'hooks', FILE)

/** @returns {{ found: boolean, version: string | null }} */
export function detect() {
  // HINTY_AGENTS_GROK = an absolute path of the `grok` executable; default: `grok` by our own PATH lookup, no shell
  const launch = resolveProgram('grok', process.env.HINTY_AGENTS_GROK)
  if (!launch) return { found: false, version: null }
  const r = runSync(launch, ['--version'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) return { found: false, version: null }
  const m = String(r.stdout || '').match(/(\d+\.\d+\.\d+)/)
  return { found: true, version: m ? m[1] : String(r.stdout || '').trim().slice(0, 40) }
}

/**
 * The hook command: this Node.js by full path (never `node` by name, security review 2, Z3), the script, the event.
 * @param {string} event @param {number} [holdS]
 */
export const commandFor = (event, holdS) =>
  `${nodeCommand()} ${q(path.join(hooksDir(), 'grok-hook.cjs'))} ${event}${holdS ? ` ${holdS}` : ''}`

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
  steps.push({ step: 'node', ok: true, message: `the hooks start Node.js by its full path (${nodeCommand()}); if you remove or move this Node.js, run install grok again (doctor checks it)` })
  if (cmdOnlyNode()) steps.push({ step: 'WARNING', ok: true, message: 'Node.js is in a folder with spaces and this drive has no short (8.3) names: the hook command starts in cmd.exe only, not in PowerShell or sh. If Grok uses another shell, install Node.js in a folder without spaces and run install grok again.' })
  // the command really starts (review 3, P3); with --ask-shell a hook that does not start = no veto at all (Grok fails open)
  const probe = probeHook(commandFor('SessionStart'), 'grok')
  steps.push({ step: 'check', ok: probe.ok !== false, message: probe.ok === false && o.askShell ? `${probe.text}: Grok would RUN every shell step without asking the glasses` : probe.text })
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
  return { ok: probe.ok !== false, steps }
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

/**
 * @returns {{ installed: boolean, askShell: boolean, file: string, node: { ok: boolean, node: string, byName: boolean } | null, command: string | null }}
 *   node: the Node.js the hook commands start (doctor checks it); command: one of our hook commands, the PreToolUse one
 *   when there is one (doctor runs it with --ping)
 */
export function installed() {
  const file = hooksFile()
  if (!isOurFile(file)) return { installed: false, askShell: false, file, node: null, command: null }
  let askShell = false
  /** @type {{ ok: boolean, node: string, byName: boolean } | null} */
  let node = null
  /** @type {string | null} */
  let command = null
  try {
    const hooks = JSON.parse(fs.readFileSync(file, 'utf8'))?.hooks || {}
    askShell = !!hooks.PreToolUse
    for (const groups of Object.values(hooks)) {
      for (const gr of Array.isArray(groups) ? groups : []) {
        for (const h of Array.isArray(gr && gr.hooks) ? gr.hooks : []) {
          if (typeof h?.command !== 'string' || !h.command.includes(MARKER)) continue
          const n = checkCommandNode(h.command)
          if (!node || (node.ok && !n.ok)) node = n
          if (!command || / PreToolUse\b/.test(h.command)) command = h.command
        }
      }
    }
  } catch { /* unreadable */ }
  return { installed: true, askShell, file, node, command }
}

/** Is ask-shell on (installed with --ask-shell)? */
export const askShellOn = () => installed().askShell

/** The exception list: DEFAULT_EXCEPT, or the person's own in ~/.hinty-agents/config.json -> grok.except. @returns {string[]} */
export function exceptions() {
  const own = /** @type {any} */ (readConfig())?.grok?.except
  return Array.isArray(own) && own.every((x) => typeof x === 'string') ? own : DEFAULT_EXCEPT
}

/** Options that make a read-only command write a file or run something (git diff --output=x, git -c, --ext-diff...). */
const RISKY_ARG = /^(?:-o|--output(?:=|$)|--output-directory|--ext-diff|--textconv|--exec|--upload-pack|--receive-pack|--config|--git-dir|--work-tree|--namespace|-c$|-C$)/

/**
 * Is this shell command harmless enough to skip the card? Security review point 9: ONE command, no chaining at all
 * (`&`, `;`, `|`), no redirection, substitution, variable, glob escape or newline; it must start with an exception
 * (whole words), no argument may make it write or run something, and a file argument of cat/head/tail/wc/type must
 * stay inside the project (no absolute path, `..`, `~`). Pure.
 * @param {string} command @param {string[]} list
 */
export function isExcepted(command, list = DEFAULT_EXCEPT) {
  const c = String(command || '').trim()
  if (!c || c.length > 500 || /[`<>&;|\n\r$\\^%!'"(){}[\]*?]/.test(c) || /[\x00-\x1f\x7f-\x9f]/.test(c)) return false
  const p = list.find((x) => typeof x === 'string' && x && (c === x || c.startsWith(`${x} `)))
  if (!p) return false
  const args = c.slice(p.length).trim().split(/\s+/).filter(Boolean)
  if (args.some((a) => RISKY_ARG.test(a) || /^--?[A-Za-z-]+=/.test(a) && /output|exec|config|dir|path|file/i.test(a))) return false
  if (/^(cat|head|tail|wc|type)$/.test(p.split(' ')[0])) {
    if (args.some((a) => /^[\\/~]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$)/.test(a))) return false
  }
  return true
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
