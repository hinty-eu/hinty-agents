// @ts-check
// The worker behind the desktop app (desktop/ in this repository). The app starts `<bundled node> bin/hinty-agents.js
// desktop` with an IPC channel and sends one request at a time per button. Every request is one of the CLI's own
// commands (the same functions, their printed lines collected and sent back) or a read of the state, so the app adds no
// second way to do anything: pairing keeps the 4-digit check from the person's own panel (review 2, Z10, shared code in
// cli.js `pairComputer`), away mode and the remote switch-on consent are the same config and service calls, connecting
// and disconnecting an agent are the adapters' install and uninstall. The security model of README "Security" holds as
// it is; the only difference is the Node.js: the bundled one (see app.js, claude.js `hookNode`).
//
// Messages (Node's IPC channel, JSON):
//   app -> worker  { t: 'req', id, m, p }       m = a name in METHODS, p = an object
//   worker -> app  { t: 'res', id, ok, r | err } { t: 'ev', ev, d }   events: line, pair, voice
import os from 'node:os'
import * as cli from './cli.js'
import { ADAPTERS } from './adapters/index.js'
import { nodeExe } from './adapters/hookfiles.js'
import { status as daemonStatus } from './client.js'
import { CHECK_TRIES, prettyCode } from './pair.js'
import { homeDir, isPaired, readConfig, updateConfig } from './store.js'
import { oneLine } from './text.js'
import { installVoice, removeVoice, voiceStatus } from './stt/install.js'
import { DEFAULT_MODEL, MODELS } from './stt/models.js'
import { VERSION } from './version.js'

/** @typedef {{ stage: 'code' | 'check', code: string | null, expiresAt: number, account: string | null, left: number,
 *   ctrl: AbortController, answer: ((v: string | null) => void) | null }} Pairing */

/** @type {Pairing | null} */
let pairing = null
/** the last pairing that ended (shown once by the window, also after it was reopened) */
let pairingEnded = /** @type {Record<string, any> | null} */ (null)
let copyError = ''
let voiceBusy = false

/** @param {string} ev @param {Record<string, any>} d */
function emit(ev, d) {
  if (process.send && process.connected) process.send({ t: 'ev', ev, d })
}

// ------------------------------------------------------------------------------------------------
// Commands run one after another; their printed lines are collected (cli.setOutput) and sent back with the answer
// ------------------------------------------------------------------------------------------------

let queue = Promise.resolve()
/**
 * @template T @param {() => Promise<T>} fn @returns {Promise<{ code: number, lines: string[], r?: T }>}
 */
function command(fn) {
  const run = async () => {
    /** @type {string[]} */
    const lines = []
    cli.setOutput((s) => { lines.push(s); emit('line', { text: s }) })
    try {
      const r = await fn()
      return { code: typeof r === 'number' ? r : 0, lines, ...(typeof r === 'number' ? {} : { r }) }
    } catch (e) {
      lines.push(`✗ ${oneLine(e instanceof Error ? e.message : String(e), 300)}`)
      return { code: 1, lines }
    } finally { cli.setOutput(null) }
  }
  const p = queue.then(run, run)
  queue = p.then(() => {}, () => {})
  return p
}

/** @param {unknown} p @returns {Record<string, any>} */
const obj = (p) => (p && typeof p === 'object' && !Array.isArray(p) ? /** @type {any} */ (p) : {})
/** @param {unknown} v */
const agentId = (v) => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(ADAPTERS, v) ? v : null)

// ------------------------------------------------------------------------------------------------
// State
// ------------------------------------------------------------------------------------------------

async function state() {
  const cfg = readConfig()
  const api = cli.apiFor(cfg)
  const s = await daemonStatus()
  return {
    version: VERSION,
    node: process.versions.node,
    runtime: nodeExe(),
    home: homeDir(),
    host: os.hostname(),
    copyError,
    paired: isPaired(cfg),
    api,
    panelUrl: cli.panelUrl(api),
    label: cfg && cfg.label ? oneLine(cfg.label, 60) : null,
    account: cfg && cfg.account ? oneLine(cfg.account, 60) : null,
    remoteAwayOn: !!cfg && cfg.remoteAwayOn === true,
    stopped: !!cfg && cfg.stopped === true,
    service: s ? {
      pid: s.pid,
      connected: !!(s.relay && s.relay.connected),
      lastError: s.relay && s.relay.lastError ? oneLine(s.relay.lastError, 80) : null,
      away: s.away,
      perms: s.perms,
      sessions: (s.sessions || []).map((/** @type {any} */ x) => ({ label: oneLine(x.label, 40), agent: oneLine(x.agent, 12), st: oneLine(x.st, 8) })),
      voice: s.voice || null,
    } : null,
    older: s ? 0 : cli.olderServicePid(),
    pairing: pairing ? { stage: pairing.stage, code: pairing.code, pretty: pairing.code ? prettyCode(pairing.code) : null, expiresAt: pairing.expiresAt, account: pairing.account, left: pairing.left, tries: CHECK_TRIES } : null,
    pairingEnded,
    voiceBusy,
  }
}

/** Every agent: found on this computer (version), connected (hooks / plugin installed). Runs the agents' --version. */
function agents() {
  return Object.keys(ADAPTERS).map((id) => {
    const a = ADAPTERS[id]
    /** @type {Record<string, any>} */
    const row = { id, name: id === 'claude' ? 'Claude Code' : cli.NAMES[id], found: false, version: null, installed: false }
    try {
      const f = a.detect()
      row.found = !!f.found
      row.version = f.version ? oneLine(f.version, 40) : null
      if (id === 'claude') {
        if (f.found) {
          const i = a.installed()
          row.installed = !!i.installed
          row.enabled = !!i.enabled
          row.pluginVersion = i.version ? oneLine(i.version, 20) : null
          row.update = !!i.installed && i.version !== VERSION
        }
      } else {
        const i = a.installed()
        row.installed = !!i.installed
        if (id === 'codex') row.complete = !!i.complete
        if (id === 'grok') row.askShell = !!i.askShell
      }
    } catch (e) { row.error = oneLine(e instanceof Error ? e.message : String(e), 120) }
    return row
  })
}

// ------------------------------------------------------------------------------------------------
// Pairing: the same flow as the wizard (cli.pairComputer); the 4 digits come from the window
// ------------------------------------------------------------------------------------------------

/** @param {Record<string, any>} p */
async function pairStart(p) {
  if (pairing) return { ok: false, why: 'busy' }
  if (isPaired(readConfig())) return { ok: false, why: 'paired' }
  const api = cli.apiFor(null)
  // the wizard's checks first: the stable program copy, a server other than Hinty's only over https or to this computer
  const pre = await command(async () => (cli.useStableCopy() && cli.checkApi(api) ? 0 : 1))
  if (pre.code !== 0) return { ok: false, why: 'setup', lines: pre.lines }
  const label = typeof p.label === 'string' && p.label.trim() ? p.label.trim().slice(0, 60) : os.hostname().slice(0, 60)
  /** @type {Pairing} */
  const me = { stage: 'code', code: null, expiresAt: 0, account: null, left: CHECK_TRIES, ctrl: new AbortController(), answer: null }
  pairing = me
  pairingEnded = null
  cli.pairComputer({
    api, label, signal: me.ctrl.signal, retryHint: 'get a new code',
    onCode: (code, expiresIn) => {
      me.code = code
      me.expiresAt = Date.now() + expiresIn * 1000
      emit('pair', { stage: 'code', code, pretty: prettyCode(code), expiresIn, url: cli.panelUrl(api) })
    },
    onClaimed: (account) => {
      me.stage = 'check'
      me.account = account
      emit('pair', { stage: 'claimed', account })
    },
    askCheck: (attempt) => new Promise((resolve) => {
      me.answer = resolve
      emit('pair', { stage: 'ask', attempt, left: me.left })
    }),
    onMismatch: (left) => {
      me.left = left
      emit('pair', { stage: 'mismatch', left })
    },
  }).then(async (r) => {
    if (pairing === me) pairing = null
    if (r.ok) {
      // the remote switch-on stays off until the person turns it on in the window (the wizard's default answer)
      if (r.cfg.remoteAwayOn === undefined) updateConfig({ remoteAwayOn: false })
      const s = await cli.startDaemon().catch(() => null)
      pairingEnded = { ok: true, account: r.account, label, service: !!s }
    } else {
      pairingEnded = { ok: false, failedAt: r.stage, code: r.code, message: r.message, told: r.told }
    }
    emit('pair', { stage: 'end', ...pairingEnded })
  }, (e) => {
    if (pairing === me) pairing = null
    pairingEnded = { ok: false, failedAt: 'pair', code: 'other', message: oneLine(e instanceof Error ? e.message : String(e), 200) }
    emit('pair', { stage: 'end', ...pairingEnded })
  })
  return { ok: true }
}

/** @param {Record<string, any>} p */
function pairCheck(p) {
  if (!pairing || !pairing.answer) return { ok: false, why: 'not_asking' }
  const answer = pairing.answer
  pairing.answer = null
  // what the person typed, as typed: checkMatches accepts exactly 4 digits and nothing else
  answer(typeof p.digits === 'string' ? p.digits.slice(0, 16) : '')
  return { ok: true }
}

function pairCancel() {
  if (!pairing) return { ok: true }
  const me = pairing
  me.ctrl.abort()
  // waiting for the 4 digits: no more input, so the flow refuses and tells the server to drop this computer again
  if (me.answer) { const a = me.answer; me.answer = null; a(null) }
  return { ok: true }
}

// ------------------------------------------------------------------------------------------------
// Voice
// ------------------------------------------------------------------------------------------------

/** @param {Record<string, any>} p */
function voiceInstall(p) {
  const model = typeof p.model === 'string' && MODELS[p.model] && MODELS[p.model].kind !== 'vad' ? p.model : DEFAULT_MODEL
  if (voiceBusy) return Promise.resolve({ code: 1, lines: ['busy'] })
  voiceBusy = true
  let last = 0
  return command(async () => {
    try {
      await installVoice({
        model,
        out: (s) => cli.printLine(s),
        progress: (v) => {
          const now = Date.now()
          if (v.phase === 'download' && v.done < v.total && now - last < 200) return
          last = now
          emit('voice', v)
        },
      })
      await cli.tellService()
      return 0
    } finally { voiceBusy = false }
  })
}

// ------------------------------------------------------------------------------------------------
// The request table
// ------------------------------------------------------------------------------------------------

/** @type {Record<string, (p: Record<string, any>) => any>} */
const METHODS = {
  hello: () => ({ version: VERSION, node: process.versions.node, runtime: nodeExe(), pid: process.pid }),
  state: () => state(),
  agents: () => command(async () => agents()),
  pairStart,
  pairCheck,
  pairCancel,
  away: (p) => command(() => cli.away(p.on === true ? 'on' : 'off')),
  remoteAway: (p) => command(() => cli.remoteAwayCmd(p.on === true ? 'on' : 'off')),
  install: (p) => {
    const id = agentId(p.agent)
    if (!id) return { code: 1, lines: ['unknown agent'] }
    return command(() => cli.installCmd(id, id === 'grok' && p.askShell === true ? ['--ask-shell'] : []))
  },
  uninstall: (p) => {
    const id = agentId(p.agent)
    if (!id) return { code: 1, lines: ['unknown agent'] }
    return command(() => cli.uninstallCmd(id))
  },
  voiceStatus: () => voiceStatus(),
  voiceInstall,
  voiceRemove: () => command(async () => { removeVoice(); await cli.tellService(); return 0 }),
  start: () => command(() => cli.start()),
  stop: () => command(() => cli.stop()),
  unpair: () => command(() => cli.unpair()),
  // --purge or --keep-data always given: the worker never asks on stdin
  uninstallAll: (p) => command(() => cli.uninstallAll([p.purge === true ? '--purge' : '--keep-data'])),
  doctor: () => command(() => cli.doctor()),
}
export const METHOD_NAMES = Object.keys(METHODS)

/**
 * Answer one request. Exported for the tests (they call it without an IPC channel).
 * @param {unknown} msg @returns {Promise<{ t: 'res', id: number, ok: boolean, r?: any, err?: string } | null>}
 */
export async function handle(msg) {
  const m = obj(msg)
  if (m.t !== 'req' || !Number.isSafeInteger(m.id)) return null
  const fn = typeof m.m === 'string' && Object.prototype.hasOwnProperty.call(METHODS, m.m) ? METHODS[m.m] : null
  if (!fn) return { t: 'res', id: m.id, ok: false, err: 'unknown_method' }
  try {
    return { t: 'res', id: m.id, ok: true, r: await fn(obj(m.p)) }
  } catch (e) {
    return { t: 'res', id: m.id, ok: false, err: oneLine(e instanceof Error ? e.message : String(e), 300) }
  }
}

/** `hinty-agents desktop`: serve the app until it closes the channel. @returns {Promise<number>} */
export async function runDesktop() {
  if (!process.send) {
    process.stdout.write('This command is for the Hinty Agents desktop app (it talks over an IPC channel). In a terminal use: npx hinty-agents\n')
    return 1
  }
  // the program copy the service, the hooks and the plugin use (as at every CLI start); a failure is shown in the window
  const pre = await command(async () => (cli.useStableCopy() ? 0 : 1))
  copyError = pre.code === 0 ? '' : pre.lines.join(' ').slice(0, 300)
  process.on('message', (msg) => {
    handle(msg).then((res) => { if (res && process.send && process.connected) process.send(res) })
  })
  emit('ready', { version: VERSION, node: process.versions.node })
  await new Promise((resolve) => process.on('disconnect', resolve))
  pairCancel()
  return 0
}
