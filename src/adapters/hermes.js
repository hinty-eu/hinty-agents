// @ts-check
// Hermes Agent adapter (plan E5, docs/podpowiedzi/E5-openclaw-hermes.md section 2). Hermes has a general plugin system
// with an "approval transport": a plugin that receives every approval prompt Hermes would show a person. Our plugin
// (hermes-plugin/hinty-agents, Python, standard library only) lives in Hermes's process and talks to this service on
// 127.0.0.1 with the same secret + HMAC proof as the Claude Code hooks.
//
// Install changes three Hermes settings and enables the plugin; it remembers the previous values so `uninstall` puts
// them back (it never leaves `transport: hinty` behind with `transport_fallback: deny`, which would refuse every
// approval once the bridge is gone):
//   security.approval.transport_fallback  -> builtin   (set FIRST: no answer / no bridge = Hermes's normal prompt, N1)
//   security.approval.transport           -> hinty
//   plugins.entries.hinty-agents.allow_gateway_injection -> true   (needed for ctx.inject_message in a gateway)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { homeDir, readJson, writeJson } from '../store.js'
import { activeRoot } from '../root.js'
import { glassesLine } from '../text.js'
import { SID_RE } from '../sessions.js'
import { resolveProgram, runSync } from '../exec.js'

export const id = 'hermes'
export const caps = { perm: 'prompt-only', say: 'queue' }
export const PLUGIN = 'hinty-agents'
export const MARKER = 'hinty-agents-marker'
export const MIN_VERSION = '0.21.5'
/** Hermes's documented defaults when a key is absent. */
const DEFAULTS = { transport: 'builtin', fallback: 'deny', injection: null }

export const pluginSource = () => path.join(activeRoot(), 'hermes-plugin', 'hinty-agents')
export const hermesHome = () => process.env.HERMES_HOME
  || (process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'hermes') : path.join(os.homedir(), '.hermes'))
export const pluginDir = () => path.join(hermesHome(), 'plugins', PLUGIN)
export const backupFile = () => path.join(homeDir(), 'hermes', 'backup.json')

/**
 * `hermes` by our own PATH lookup (never the current folder), no shell; HINTY_AGENTS_HERMES = an absolute path of the
 * executable (a .js/.mjs/.cjs is run with node).
 * @param {string[]} args @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function run(args) {
  const launch = resolveProgram('hermes', process.env.HINTY_AGENTS_HERMES)
  if (!launch) return { status: null, stdout: '', stderr: 'hermes not found' }
  const r = runSync(launch, args, { encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}

/** @returns {{ found: boolean, version: string | null }} */
export function detect() {
  const r = run(['--version'])
  if (r.status !== 0) return { found: false, version: null }
  const m = r.stdout.match(/(\d+\.\d+\.\d+)/)
  return { found: true, version: m ? m[1] : r.stdout.trim().slice(0, 40) }
}

/** @param {string} a @param {string} b 1 when a > b */
export function cmpVersion(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1
  return 0
}

/**
 * Value of a nested key in simple block-style YAML (Hermes's config.yaml), or undefined. Pure.
 * @param {string} text @param {string[]} keys
 * @returns {string | undefined}
 */
export function yamlGet(text, keys) {
  /** @type {Array<{ indent: number, key: string }>} */
  const stack = []
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const m = raw.match(/^(\s*)([^\s:#-][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/)
    if (!m) continue
    const ind = m[1].length
    while (stack.length && stack[stack.length - 1].indent >= ind) stack.pop()
    const key = m[2].replace(/^["']|["']$/g, '')
    const val = (m[3] || '').replace(/\s+#.*$/, '').trim()
    if (!val) { stack.push({ indent: ind, key }); continue }
    const full = [...stack.map((x) => x.key), key]
    if (full.length === keys.length && full.every((k, i) => k === keys[i])) return val.replace(/^["']|["']$/g, '')
  }
  return undefined
}

/** @returns {{ transport?: string, fallback?: string, injection?: string, plugins: string }} */
export function readSettings() {
  let text = ''
  try { text = fs.readFileSync(path.join(hermesHome(), 'config.yaml'), 'utf8') } catch { /* none */ }
  return {
    transport: yamlGet(text, ['security', 'approval', 'transport']),
    fallback: yamlGet(text, ['security', 'approval', 'transport_fallback']),
    injection: yamlGet(text, ['plugins', 'entries', PLUGIN, 'allow_gateway_injection']),
    plugins: text,
  }
}

const isOurDir = (/** @type {string} */ d) => {
  try { return fs.readFileSync(path.join(d, '__init__.py'), 'utf8').includes(MARKER) } catch { return false }
}

/** @returns {{ installed: boolean, dir: string, transport?: string, fallback?: string }} */
export function installed() {
  const s = readSettings()
  return { installed: isOurDir(pluginDir()), dir: pluginDir(), transport: s.transport, fallback: s.fallback }
}

/** @param {string} src @param {string} dst */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '__pycache__') continue
    const a = path.join(src, e.name)
    const b = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(a, b)
    else fs.copyFileSync(a, b)
  }
}

/**
 * @returns {{ ok: boolean, steps: Array<{ step: string, ok: boolean, message: string }> }}
 */
export function install() {
  /** @type {Array<{ step: string, ok: boolean, message: string }>} */
  const steps = []
  const found = detect()
  if (!found.found) {
    steps.push({ step: 'hermes', ok: false, message: 'Hermes Agent (`hermes`) was not found on PATH (or HINTY_AGENTS_HERMES)' })
    return { ok: false, steps }
  }
  if (found.version && cmpVersion(found.version, MIN_VERSION) < 0) {
    steps.push({ step: 'version', ok: false, message: `Hermes ${found.version} is older than ${MIN_VERSION} (approval transports need it); update Hermes first` })
    return { ok: false, steps }
  }
  const dst = pluginDir()
  if (fs.existsSync(dst) && !isOurDir(dst)) {
    steps.push({ step: 'plugin', ok: false, message: `${dst} exists and is not ours; left untouched` })
    return { ok: false, steps }
  }
  // remember what the person had, once (a second install must not record our own values as theirs)
  if (!fs.existsSync(backupFile())) {
    const s = readSettings()
    fs.mkdirSync(path.dirname(backupFile()), { recursive: true })
    writeJson(backupFile(), { v: 1, transport: s.transport ?? null, fallback: s.fallback ?? null, injection: s.injection ?? null, at: new Date().toISOString() })
    steps.push({ step: 'backup', ok: true, message: `previous settings noted in ${backupFile()}` })
  }
  fs.rmSync(dst, { recursive: true, force: true })
  copyDir(pluginSource(), dst)
  steps.push({ step: 'plugin', ok: true, message: dst })
  /** @type {Array<[string, string[]]>} */
  const cmds = [
    ['enable plugin', ['plugins', 'enable', PLUGIN]],
    ['fallback builtin', ['config', 'set', 'security.approval.transport_fallback', 'builtin']],
    ['gateway injection', ['config', 'set', `plugins.entries.${PLUGIN}.allow_gateway_injection`, 'true']],
    ['transport hinty', ['config', 'set', 'security.approval.transport', 'hinty']],
  ]
  for (const [name, args] of cmds) {
    const r = run(args)
    const ok = r.status === 0
    steps.push({ step: name, ok, message: ok ? `hermes ${args.join(' ')}` : `hermes ${args.join(' ')} failed${r.status === null ? ' (timed out)' : ''}: ${(r.stderr || r.stdout).trim().slice(0, 120)}` })
    if (!ok) return { ok: false, steps }
  }
  steps.push({ step: 'restart', ok: true, message: 'restart the Hermes gateway / open sessions: plugins are loaded once per process' })
  steps.push({
    step: 'NOTE', ok: true,
    message: 'while away mode is on, an approval prompt waits for your answer from the glasses/panel and appears in the terminal only when that wait ends; switch away mode off at the desk',
  })
  return { ok: true, steps }
}

/**
 * Puts the previous settings back (transport first, so approvals never go to a plugin that is going away).
 * @returns {{ ok: boolean, steps: Array<{ step: string, ok: boolean, message: string }> }}
 */
export function uninstall() {
  /** @type {Array<{ step: string, ok: boolean, message: string }>} */
  const steps = []
  const b = readJson(backupFile()) || {}
  const prev = {
    transport: typeof b.transport === 'string' ? b.transport : DEFAULTS.transport,
    fallback: typeof b.fallback === 'string' ? b.fallback : DEFAULTS.fallback,
    injection: typeof b.injection === 'string' ? b.injection : 'false',
  }
  // a transport left behind by someone else (not ours) is not touched
  const cur = readSettings()
  /** @type {Array<[string, string[]]>} */
  const cmds = []
  if (cur.transport === 'hinty') cmds.push(['transport', ['config', 'set', 'security.approval.transport', prev.transport === 'hinty' ? 'builtin' : prev.transport]])
  cmds.push(['fallback', ['config', 'set', 'security.approval.transport_fallback', prev.fallback]])
  cmds.push(['gateway injection', ['config', 'set', `plugins.entries.${PLUGIN}.allow_gateway_injection`, prev.injection]])
  cmds.push(['disable plugin', ['plugins', 'disable', PLUGIN]])
  let ok = true
  if (!detect().found) {
    steps.push({ step: 'hermes', ok: false, message: `\`hermes\` not found; run by hand: ${cmds.map(([, a]) => 'hermes ' + a.join(' ')).join(' ; ')}` })
    ok = false
  } else {
    for (const [name, args] of cmds) {
      const r = run(args)
      const good = r.status === 0
      if (!good) ok = false
      steps.push({ step: name, ok: good, message: good ? `hermes ${args.join(' ')}` : `hermes ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 120)}` })
    }
  }
  if (ok) {
    if (isOurDir(pluginDir())) { fs.rmSync(pluginDir(), { recursive: true, force: true }); steps.push({ step: 'plugin', ok: true, message: `removed ${pluginDir()}` }) }
    try { fs.rmSync(path.dirname(backupFile()), { recursive: true, force: true }) } catch { /* gone */ }
  } else {
    steps.push({ step: 'plugin', ok: false, message: 'settings could not all be restored, so the plugin folder stays; fix the lines above and run uninstall again' })
  }
  return { ok, steps }
}

/** Extra doctor lines. @returns {Array<{ ok: boolean | null, text: string, hint?: string }>} */
export function doctor() {
  /** @type {Array<{ ok: boolean | null, text: string, hint?: string }>} */
  const out = []
  const f = detect()
  const inst = installed()
  const s = readSettings()
  if (f.found && f.version) out.push({ ok: cmpVersion(f.version, MIN_VERSION) >= 0, text: `Hermes ${f.version}${cmpVersion(f.version, MIN_VERSION) >= 0 ? '' : ` (needs ${MIN_VERSION}+ for approval transports)`}` })
  out.push({ ok: inst.installed ? true : null, text: inst.installed ? `Hermes plugin in ${inst.dir}` : 'Hermes plugin not installed', hint: inst.installed ? undefined : 'npx hinty-agents install hermes' })
  if (s.transport === 'hinty') {
    out.push({ ok: inst.installed, text: inst.installed ? 'security.approval.transport is hinty' : 'security.approval.transport is hinty but the plugin is missing: Hermes would refuse every approval', hint: 'npx hinty-agents uninstall hermes' })
    out.push({ ok: s.fallback === 'builtin', text: `security.approval.transport_fallback is ${s.fallback ?? 'unset (deny)'}`, hint: s.fallback === 'builtin' ? undefined : 'hermes config set security.approval.transport_fallback builtin (otherwise a missing bridge = every approval denied)' })
    out.push({ ok: s.injection === 'true' ? true : null, text: `plugins.entries.${PLUGIN}.allow_gateway_injection is ${s.injection ?? 'unset'}`, hint: s.injection === 'true' ? undefined : 'without it messages from the glasses cannot reach gateway sessions' })
  } else if (inst.installed) {
    out.push({ ok: null, text: `Hermes plugin installed but security.approval.transport is ${s.transport ?? 'unset'}`, hint: 'hermes config set security.approval.transport hinty' })
  }
  return out
}

// ------------------------------------------------------------------------------------------------
// The live part: routes the plugin calls (through the service's local HTTP port)
// ------------------------------------------------------------------------------------------------

const POLL_FRESH_MS = 60 * 1000
const ACK_WAIT_MS = 10 * 1000
const SAFETY_MS = 7000

/**
 * Traces of Hermes's own redaction and display clean-up (security review 2, Z2). The plugin only ever sees Hermes's
 * DISPLAY copy of a command (`redact_approval_display(command, force=True)`), never the raw one, and Hermes hides
 * secrets there the way our old mask did: what runs may be inside the hidden part. Every marker Hermes 0.23 writes
 * (agent/redact.py, agent/redact_approval_display.py): `***` (masked value, `KEY=***`, `:***@`), `head...tail`
 * (mask_secret), `«redacted:…»` / `«redacted-secret»`, `[REDACTED PRIVATE KEY]`, `[redacted: nesting limit]`,
 * `[redaction-unavailable]`, `⟨+N blank lines⟩` / `⟨+N whitespace chars⟩` / `⟨\uXXXX ×N⟩`. A card with any of them is
 * incomplete (`part`): deny from the glasses, allow only in Hermes's own prompt. `git diff a...b` and `go test ./...`
 * pay the same price.
 */
export const HERMES_TRACE = /\*\*\*|\.\.\.|…|«\s*redact|\[\s*redact|⟨/i

/** @param {string} s */
export const hermesRedacted = (s) => HERMES_TRACE.test(String(s || ''))

/** @typedef {import('../service.js').Service} Service */

export class HermesLink {
  /** @param {{ service: Service, log?: (m: string, f?: Record<string, any>) => void, now?: () => number }} o */
  constructor(o) {
    this.service = o.service
    this.log = o.log || (() => {})
    this.now = o.now || Date.now
    this.lastPoll = 0
    this.canSay = true
    /** @type {Map<string, string>} sid -> session_key (for inject_message) */
    this.keys = new Map()
    /** @type {Map<string, string>} session_key -> sid */
    this.alias = new Map()
    /** @type {Array<{ id: string, sid: string, session_key: string, text: string }>} */
    this.queue = []
    /** @type {Set<() => void>} */
    this.pollers = new Set()
    /** @type {Map<string, (ok: boolean) => void>} */
    this.acks = new Map()
    this.seq = 0
    /** @type {Map<string, string>} request_id -> rid */
    this.pendingPerms = new Map()
    service_attach(this)
  }

  /** @param {unknown} v @returns {v is Record<string, any>} */
  static isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }

  /** @param {string} sid @param {string} key */
  link(sid, key) {
    if (!key) return
    this.keys.set(sid, key)
    this.alias.set(key, sid)
  }

  /** The session id the relay uses: Hermes's session_id when known, else its session_key. @param {any} b */
  sidOf(b) {
    const sid = typeof b.session_id === 'string' && b.session_id ? b.session_id : ''
    const key = typeof b.session_key === 'string' ? b.session_key : ''
    const out = sid || this.alias.get(key) || key
    if (!SID_RE.test(out)) return ''
    if (sid) this.link(sid, key)
    return out
  }

  /**
   * An approval prompt. `{d:'allow'|'deny'}` only after a person decided; `{d:null}` otherwise, at once when away mode is
   * off or the link is down, so Hermes shows its normal prompt without delay (N1, N5).
   * @param {unknown} body @param {import('../service.js').Ctl} [ctl]
   */
  async perm(body, ctl = {}) {
    const none = { d: null }
    if (!HermesLink.isObj(body) || !this.service.hooksLive()) return none
    const timeoutS = Number(body.timeout_seconds)
    const ttlS = Math.floor((Number.isFinite(timeoutS) ? timeoutS : 60) - SAFETY_MS / 1000)
    if (ttlS < 5) return none
    const sid = this.sidOf(body)
    if (!sid) return none
    const request = typeof body.request_id === 'string' ? body.request_id : ''
    const command = typeof body.command === 'string' ? body.command : ''
    const description = typeof body.description === 'string' ? body.description : ''
    const tool = typeof body.pattern_key === 'string' && body.pattern_key ? body.pattern_key : 'terminal'
    const entry = { rid: '' }
    // complete only with a command and without any trace of Hermes's redaction in what we were given (Z2)
    const complete = !!command.trim() && !hermesRedacted(command) && !hermesRedacted(description)
    const answer = await this.service.requestPerm(
      { sid, cwd: '', tool, input: { request_id: request, command, description }, agentId: null, agentType: '', cardText: `${description ? description + '\n' : ''}${command}`, cardComplete: complete, label: 'hermes' },
      ctl, { agent: 'hermes', ttlMs: Math.min(ttlS, 3600) * 1000, onCreate: (p) => { entry.rid = p.rid; if (request) this.pendingPerms.set(request, p.rid) } },
    )
    if (request) this.pendingPerms.delete(request)
    return { d: answer && answer.d ? answer.d : null }
  }

  /**
   * Hook events from the plugin: state of the session, last answer.
   * @param {unknown} body
   */
  event(body) {
    if (!HermesLink.isObj(body) || typeof body.ev !== 'string') return { ok: false, away: this.service.away.isOn() }
    const away = this.service.away.isOn()
    if (!away || !this.service.hooksLive()) return { ok: true, away }
    const sid = this.sidOf(body)
    if (!sid) return { ok: true, away }
    const ev = body.ev
    const platform = typeof body.platform === 'string' ? body.platform : ''
    const base = { sid, label: 'hermes' + (platform && platform !== 'cli' ? `·${platform}` : ''), say: this.canSay }
    switch (ev) {
      case 'pre_llm_call': this.service.agentSession('hermes', { ...base, st: 'run' }); break
      case 'post_llm_call': {
        const text = typeof body.text === 'string' ? body.text : ''
        this.service.agentSession('hermes', { ...base, st: 'done', ...(text ? { line: glassesLine(text), answer: text } : {}) })
        break
      }
      case 'on_session_end': {
        const o = body.outcome
        this.service.agentSession('hermes', { ...base, st: o === 'failed' ? 'err' : o === 'interrupted' ? 'idle' : 'done' })
        break
      }
      case 'on_human_input_request':
        if (body.kind === 'clarify') this.service.agentSession('hermes', { ...base, st: 'ask' })
        break
      case 'on_human_input_resolved':
        if (body.kind === 'clarify') this.service.agentSession('hermes', { ...base, st: 'run' })
        break
      case 'post_approval_response':
        // a prompt that ended some other way (cancelled, interrupted) closes its card
        if (typeof body.choice === 'string' && /^transport_(interrupted|cancelled)/.test(body.choice)) {
          for (const p of this.service.perms.list((x) => x.sid === sid)) this.service.endPerm(p.rid, 'cancel')
        }
        break
      case 'on_session_finalize':
        this.service.endSession(sid)
        this.keys.delete(sid)
        break
      default:
    }
    return { ok: true, away }
  }

  /**
   * The plugin asks for messages (held up to `wait` seconds, at most 25).
   * @param {unknown} body @param {import('../service.js').Ctl} [ctl]
   */
  async poll(body, ctl = {}) {
    this.lastPoll = this.now()
    if (HermesLink.isObj(body) && typeof body.can_say === 'boolean') this.canSay = body.can_say
    const away = this.service.away.isOn()
    const take = () => {
      const cmds = this.queue.splice(0).map((c) => ({ id: c.id, session_key: c.session_key, text: c.text }))
      return { away: this.service.away.isOn(), cmds }
    }
    if (!away || this.queue.length) return take()
    const wait = Math.max(0, Math.min(HermesLink.isObj(body) && typeof body.wait === 'number' ? body.wait : 20, 25)) * 1000
    if (!wait) return take()
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.pollers.delete(done); resolve(undefined) }
      const timer = setTimeout(done, wait)
      this.pollers.add(done)
      ctl.onAbort?.(done)
    })
    return take()
  }

  /** @param {unknown} body {id, ok} */
  ack(body) {
    if (!HermesLink.isObj(body) || typeof body.id !== 'string') return { ok: false }
    const f = this.acks.get(body.id)
    if (f) { this.acks.delete(body.id); f(body.ok === true) }
    return { ok: true }
  }

  /** Away mode ended: nothing queued survives, waiting polls return. */
  clear() {
    this.queue.length = 0
    for (const f of [...this.pollers]) f()
    for (const [, f] of this.acks) f(false)
    this.acks.clear()
  }

  /**
   * A message from the glasses (already `safeInstruction`ed by the service). Resolves true when the plugin handed it to
   * Hermes (`ctx.inject_message` accepted it).
   * @param {string} sid @param {string} text @returns {Promise<boolean>}
   */
  say(sid, text) {
    if (this.now() - this.lastPoll > POLL_FRESH_MS) return Promise.resolve(false)
    const id = String(++this.seq)
    this.queue.push({ id, sid, session_key: this.keys.get(sid) || '', text })
    for (const f of [...this.pollers]) f()
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.acks.delete(id); resolve(false) }, ACK_WAIT_MS)
      this.acks.set(id, (ok) => { clearTimeout(timer); resolve(ok) })
    })
  }
}

/** @param {HermesLink} link */
function service_attach(link) {
  link.service.attachAgent('hermes', { say: (sid, text) => link.say(sid, text) })
}
