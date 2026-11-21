// @ts-check
// OpenClaw adapter (plan E5, docs/podpowiedzi/E5-openclaw-hermes.md). OpenClaw has no hooks we could install; its Gateway
// speaks a WebSocket protocol, and an "operator" client with the `operator.approvals` scope receives every approval
// request and may answer it. So the bridge becomes such a client (openclaw-client.js) - but ONLY while the service is
// "live" (paired, link up, away mode on). Why: the mere presence of an approvals client changes OpenClaw's behaviour
// (without one a request that nobody can answer ends at once and `askFallback` decides; with one it waits until its
// timeout), and at the desk we must change nothing (N5).
//
// Safety rules kept here (plan section 5):
//  N1  we never answer on our own: no answer from the glasses = no answer sent; OpenClaw then applies `askFallback`
//      (default: deny) or another window of the person decides;
//  N2  the ONLY decisions we ever send are `allow-once` and `deny` (see `decisionFor`);
//  N12 a `say` text is a plain message, three times over (security review 2, Z1):
//      1. it is sent over a SECOND connection that has no `operator.approvals` (OpenClaw refuses `/approve` from such a
//         client, however the text is dressed up), with its own device token; the approvals connection never sends chat;
//      2. it starts with a fixed line (CHAT_PREAMBLE) that OpenClaw's own clean-up (stripStructuralPrefixes: `[...]`
//         removed, `label:` at a line start removed, `\n` written out as text = a space) can never remove, so the
//         message never starts with `/` or `!`;
//      3. `disarm`: a zero-width space before every `/` or `!` that follows the start, white space, `]`, `:` or a written
//         out `\n`, OpenClaw's "current message" marker broken with a visible character (so layer 2 never depends on
//         zero-width characters), and every message checked with a copy of OpenClaw's clean-up before it is sent.
//  Z5  the card shows every field of the request that changes what runs (argv, preview, env keys, resolved path,
//      policy); env values are never sent to us, and a field we do not know, so such a card is incomplete (`part`).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { homeDir, writeJson, readJson } from '../store.js'
import { glassesLine, oneLine, safeInstruction } from '../text.js'
import { APPROVER_SCOPES, GatewayClient, WRITER_SCOPES, loadIdentity, newIdentity, saveIdentity } from './openclaw-client.js'
import { resolveProgram, runSync } from '../exec.js'

export const id = 'openclaw'
export const caps = { perm: 'gateway', say: 'chat' }
export const MAX_SESSIONS = 8
const ACTIVE_MS = 30 * 60 * 1000
const DEFAULT_PORT = 18789

export const dir = () => path.join(homeDir(), 'openclaw')
/** 0.3.0: two device identities, each with its own token (Z1) */
export const approverFile = () => path.join(dir(), 'approver.json')
export const writerFile = () => path.join(dir(), 'writer.json')
export const tokensFile = () => path.join(dir(), 'tokens.json')
/** 0.2.x: one identity whose token had every scope; never used again, `install openclaw` replaces it */
export const legacyIdentityFile = () => path.join(dir(), 'device.json')
export const legacyTokenFile = () => path.join(dir(), 'token.json')

/** @returns {{ found: boolean, version: string | null }} */
export function detect() {
  // HINTY_AGENTS_OPENCLAW = an absolute path of the `openclaw` entry; default: `openclaw` by our own PATH lookup
  // (never the current folder), started without a shell (an npm shim is mapped to node + openclaw.mjs)
  const launch = resolveProgram('openclaw', process.env.HINTY_AGENTS_OPENCLAW)
  if (!launch) return { found: false, version: null }
  const r = runSync(launch, ['--version'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) return { found: false, version: null }
  const m = String(r.stdout || '').match(/(\d{4}\.\d+\.\d+)/)
  return { found: true, version: m ? m[1] : String(r.stdout || '').trim().slice(0, 40) }
}

// ------------------------------------------------------------------------------------------------
// The user's OpenClaw configuration (read only, and only at install time to pair once)
// ------------------------------------------------------------------------------------------------

export const stateDir = () => process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw')
export const configPath = () => process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir(), 'openclaw.json')

/**
 * openclaw.json is JSON5. Best effort: JSON, else without comments and trailing commas.
 * @param {string} text @returns {any}
 */
export function parseLoose(text) {
  try { return JSON.parse(text) } catch { /* json5 */ }
  let out = ''
  let inStr = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') { out += ch + (text[++i] ?? ''); continue }
      if (ch === inStr) { out += '"'; inStr = ''; continue }
      out += ch === '"' ? '\\"' : ch
      continue
    }
    if (ch === '"' || ch === "'") { inStr = ch; out += '"'; continue }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue }
    if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue }
    out += ch
  }
  out = out.replace(/,(\s*[}\]])/g, '$1').replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
  try { return JSON.parse(out) } catch { return null }
}

/**
 * Where the Gateway is and how to authenticate the first connection.
 * @param {{ tokenFile?: string }} [o]
 * @returns {{ port: number, token: string | null, needsTokenFile?: string, mode: string }}
 */
export function gatewayInfo(o = {}) {
  /** @type {any} */
  let cfg = null
  try { cfg = parseLoose(fs.readFileSync(configPath(), 'utf8')) } catch { /* no config */ }
  const gw = (cfg && cfg.gateway) || {}
  const port = Number(process.env.OPENCLAW_GATEWAY_PORT) || Number(gw.port) || DEFAULT_PORT
  const mode = (gw.auth && gw.auth.mode) || 'token'
  let token = null
  if (o.tokenFile) {
    token = fs.readFileSync(o.tokenFile, 'utf8').trim() || null
  } else if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    token = process.env.OPENCLAW_GATEWAY_TOKEN.trim()
  } else {
    const raw = mode === 'password' ? gw.auth && gw.auth.password : gw.auth && gw.auth.token
    if (typeof raw === 'string') token = raw
    else if (raw && typeof raw === 'object') {
      const envName = raw.source === 'env' ? raw.id : raw.env
      if (typeof envName === 'string' && process.env[envName]) token = process.env[envName] || null
      else return { port, token: null, needsTokenFile: raw.source || 'secret', mode }
    }
  }
  return { port, token, mode }
}

/** Plain strings that mean "OpenClaw allows by itself when nobody answers": `askFallback: full`. @returns {string[]} files */
export function askFallbackFull() {
  const found = []
  for (const f of [path.join(stateDir(), 'exec-approvals.json'), configPath()]) {
    let j
    try { j = parseLoose(fs.readFileSync(f, 'utf8')) } catch { continue }
    const walk = (/** @type {any} */ v, depth = 0) => {
      if (!v || typeof v !== 'object' || depth > 8) return false
      for (const [k, x] of Object.entries(v)) {
        if (k === 'askFallback' && x === 'full') return true
        if (walk(x, depth + 1)) return true
      }
      return false
    }
    if (walk(j)) found.push(f)
  }
  return found
}

// ------------------------------------------------------------------------------------------------
// install / uninstall / doctor
// ------------------------------------------------------------------------------------------------

/** @param {unknown} v @returns {string[]} */
const scopeList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])

/**
 * The stored pairing (tokens.json v2 + the two identities), or null. A writer that has `operator.approvals` is never
 * accepted (Z1: chat text must not come from a client that can approve).
 * @returns {{ url: string, protocol: number, approver: { identity: import('./openclaw-client.js').Identity, deviceToken: string, scopes: string[] },
 *   writer: { identity: import('./openclaw-client.js').Identity, deviceToken: string, scopes: string[] } | null } | null}
 */
export function readPairing() {
  const t = /** @type {any} */ (readJson(tokensFile()))
  const a = loadIdentity(approverFile(), { create: false })
  if (!t || t.v !== 2 || typeof t.url !== 'string' || !a || !t.approver || typeof t.approver.deviceToken !== 'string' || t.approver.deviceId !== a.deviceId) return null
  const w = loadIdentity(writerFile(), { create: false })
  const ws = t.writer && scopeList(t.writer.scopes)
  const writer = w && t.writer && typeof t.writer.deviceToken === 'string' && t.writer.deviceId === w.deviceId &&
    ws && ws.includes('operator.write') && !ws.includes('operator.approvals')
    ? { identity: w, deviceToken: t.writer.deviceToken, scopes: ws } : null
  return { url: t.url, protocol: Number(t.protocol) || 0, approver: { identity: a, deviceToken: t.approver.deviceToken, scopes: scopeList(t.approver.scopes) }, writer }
}

/** @returns {{ installed: boolean, deviceId?: string, writerId?: string, url?: string, canWrite?: boolean, legacy?: string }} */
export function installed() {
  const p = readPairing()
  if (!p) {
    // a 0.2.x pairing: one token with every scope; it is not used any more (`install openclaw` again)
    const old = loadIdentity(legacyIdentityFile(), { create: false })
    return { installed: false, ...(old && fs.existsSync(legacyTokenFile()) ? { legacy: old.deviceId } : {}) }
  }
  return { installed: true, deviceId: p.approver.identity.deviceId, writerId: p.writer?.identity.deviceId, url: p.url, canWrite: !!p.writer }
}

/** Device ids this computer paired before (to tell the person which ones to remove from the Gateway). */
function previousDevices() {
  const ids = []
  for (const f of [legacyIdentityFile(), approverFile(), writerFile()]) {
    const i = loadIdentity(f, { create: false })
    if (i) ids.push(i.deviceId)
  }
  return ids
}

/**
 * Pair two devices with the Gateway (the first loopback connection pairs by itself): `approver` (read + approvals) and
 * `writer` (read + write), each with its own device token (Z1). The shared Gateway token is used for these two
 * connections only and is not stored anywhere. A 0.2.x pairing (one token with every scope) is replaced.
 * @param {{ tokenFile?: string, url?: string, WebSocketImpl?: any, retryMs?: number, connectTimeoutMs?: number }} [o] retryMs, connectTimeoutMs: tests
 * @returns {Promise<{ ok: boolean, steps: Array<{ step: string, ok: boolean, message: string }> }>}
 */
export async function install(o = {}) {
  const steps = []
  const info = gatewayInfo({ tokenFile: o.tokenFile })
  const url = o.url || `ws://127.0.0.1:${info.port}`
  steps.push({ step: 'gateway', ok: true, message: url })
  if (info.needsTokenFile) {
    steps.push({ step: 'token', ok: false, message: `your Gateway token is a "${info.needsTokenFile}" secret reference; give it once: npx hinty-agents install openclaw --token-file <file with the token>` })
    return { ok: false, steps }
  }
  if (!info.token) {
    steps.push({ step: 'token', ok: false, message: `no Gateway token found in ${configPath()} (or OPENCLAW_GATEWAY_TOKEN); pass --token-file <file>` })
    return { ok: false, steps }
  }
  const before = [...previousDevices(), ...readOrphans().map((x) => x.deviceId)]
  /** devices the Gateway paired (or may have paired) in this run that end up unused: the person is told to remove them */
  /** @type {Array<{ deviceId: string, why: string }>} */
  const unused = []
  /**
   * @param {string[]} scopes @param {number[]} [protocols]
   * @returns {Promise<{ identity: import('./openclaw-client.js').Identity, deviceToken: string, scopes: string[], protocol: number, version: string }>}
   */
  const pairOne = async (scopes, protocols) => {
    const identity = newIdentity()
    const client = new GatewayClient({ url, identity, token: /** @type {string} */ (info.token), scopes, protocols, WebSocketImpl: o.WebSocketImpl, ...(o.connectTimeoutMs ? { connectTimeoutMs: o.connectTimeoutMs } : {}) })
    try {
      const hello = await client.connect()
      const a = hello && hello.auth
      if (!a || typeof a.deviceToken !== 'string') throw Object.assign(new Error('the Gateway did not issue a device token'), { code: 'NO_TOKEN', deviceId: identity.deviceId })
      return { identity, deviceToken: a.deviceToken, scopes: Array.isArray(a.scopes) ? scopeList(a.scopes) : scopes, protocol: client.protocol, version: String(hello.server && hello.server.version || '?') }
    } catch (e) {
      // a timeout or a close after the challenge may come after the Gateway already paired this device
      if (e && typeof e === 'object' && !(/** @type {any} */ (e).deviceId)) /** @type {any} */ (e).deviceId = identity.deviceId
      throw e
    } finally { client.close() }
  }
  const hintOf = (/** @type {any} */ err) => (err.code === 'PAIRING_REQUIRED' ? ' (a remote Gateway needs `openclaw devices approve <requestId>`)'
    : err.code === 'AUTH_TOKEN_MISMATCH' ? ' (wrong Gateway token)' : '')
  /** @type {Awaited<ReturnType<typeof pairOne>>} */
  let approver
  /** @type {Awaited<ReturnType<typeof pairOne>> | null} */
  let writer = null
  try {
    approver = await pairOne(APPROVER_SCOPES)
  } catch (e) {
    const err = /** @type {any} */ (e)
    if (err.code === 'TIMEOUT' || err.code === 'NO_TOKEN') unused.push({ deviceId: err.deviceId, why: 'approvals device of an unfinished pairing (it may not be listed)' })
    noteOrphans(unused, steps)
    steps.push({ step: 'pairing', ok: false, message: `${err.message}${hintOf(err)}; is the Gateway running? (openclaw gateway)` })
    return { ok: false, steps }
  }
  if (!approver.scopes.includes('operator.approvals')) {
    unused.push({ deviceId: approver.identity.deviceId, why: 'approvals device without operator.approvals' })
    noteOrphans(unused, steps)
    steps.push({ step: 'pairing', ok: false, message: 'the Gateway did not grant operator.approvals: approval prompts cannot reach the glasses' })
    return { ok: false, steps }
  }
  steps.push({ step: 'pairing', ok: true, message: `approvals device ${approver.identity.deviceId.slice(0, 12)}... paired (${approver.scopes.join(', ')}; protocol ${approver.protocol}, OpenClaw ${approver.version})` })
  // the second pairing: a Gateway that has just started may not answer a second connection for some seconds (review 3,
  // P5), so up to three tries; if it still fails, the approvals device is KEPT (approvals work, instructions are off)
  /** @type {any} */
  let lastErr = null
  for (let attempt = 0; attempt < 3 && !writer; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, o.retryMs ?? 3000))
    try {
      const w = await pairOne(WRITER_SCOPES, [approver.protocol])
      lastErr = null
      if (w.scopes.includes('operator.approvals')) {
        unused.push({ deviceId: w.identity.deviceId, why: 'instructions device that was given operator.approvals' })
        steps.push({ step: 'instructions', ok: true, message: 'the Gateway gave the instructions device operator.approvals as well, so it is NOT used: instructions from the glasses are off for OpenClaw' })
      } else if (!w.scopes.includes('operator.write')) {
        unused.push({ deviceId: w.identity.deviceId, why: 'instructions device without operator.write' })
        steps.push({ step: 'instructions', ok: true, message: 'without operator.write the glasses cannot send instructions to OpenClaw sessions' })
      } else {
        writer = w
        steps.push({ step: 'pairing', ok: true, message: `instructions device ${w.identity.deviceId.slice(0, 12)}... paired (${w.scopes.join(', ')}; no operator.approvals, so a message can never approve anything)` })
      }
      break
    } catch (e) {
      lastErr = e
      if (lastErr.code === 'TIMEOUT' || lastErr.code === 'NO_TOKEN') unused.push({ deviceId: lastErr.deviceId, why: 'instructions device of an unfinished pairing (it may not be listed)' })
      if (lastErr.code === 'AUTH_TOKEN_MISMATCH' || lastErr.code === 'PAIRING_REQUIRED') break
    }
  }
  if (lastErr) {
    steps.push({ step: 'instructions', ok: false, message: `the instructions device could not be paired (${lastErr.message}${hintOf(lastErr)}): approvals work, messages from the glasses are off for OpenClaw; run install openclaw again to add it` })
  }
  saveIdentity(approverFile(), approver.identity)
  if (writer) saveIdentity(writerFile(), writer.identity)
  else { try { fs.unlinkSync(writerFile()) } catch { /* none */ } }
  writeJson(tokensFile(), {
    v: 2, url, protocol: approver.protocol,
    approver: { deviceId: approver.identity.deviceId, deviceToken: approver.deviceToken, scopes: approver.scopes, issuedAtMs: Date.now() },
    writer: writer ? { deviceId: writer.identity.deviceId, deviceToken: writer.deviceToken, scopes: writer.scopes, issuedAtMs: Date.now() } : null,
  })
  for (const f of [legacyIdentityFile(), legacyTokenFile()]) { try { fs.unlinkSync(f) } catch { /* none */ } }
  steps.push({ step: 'token', ok: true, message: `device tokens stored in ${tokensFile()} (readable by you only; they never leave this computer)` })
  const now = new Set([approver.identity.deviceId, writer?.identity.deviceId])
  // earlier pairings and unused devices of earlier runs are told once more here, then forgotten; this run's unused ones
  // are kept for doctor until the next install or uninstall
  for (const old of [...new Set(before)].filter((x) => !now.has(x))) {
    steps.push({ step: 'old device', ok: true, message: `an earlier pairing of this bridge is no longer used; revoke it: openclaw devices remove ${old}` })
  }
  try { fs.unlinkSync(orphansFile()) } catch { /* none */ }
  noteOrphans(unused, steps)
  for (const f of askFallbackFull()) steps.push({ step: 'WARNING', ok: true, message: `${f} has askFallback: full - OpenClaw then allows by itself when nobody answers in time. Set it to deny (OpenClaw's default) to keep "no answer = no".` })
  steps.push({ step: 'config', ok: true, message: 'nothing in your OpenClaw configuration was changed; the bridge connects only while away mode is on' })
  return { ok: true, steps }
}

/** Devices an unfinished or partly refused pairing left in the Gateway, with nobody holding their key (review 3, P5). */
export const orphansFile = () => path.join(dir(), 'orphans.json')

/** @returns {Array<{ deviceId: string, why: string, at: number }>} */
export function readOrphans() {
  const j = /** @type {any} */ (readJson(orphansFile()))
  const list = j && Array.isArray(j.devices) ? j.devices : []
  return list.filter((/** @type {any} */ x) => x && typeof x.deviceId === 'string' && /^[0-9a-f]{16,128}$/i.test(x.deviceId))
}

/**
 * Remember devices that ended up unused (doctor and uninstall name them) and tell the person how to remove them.
 * @param {Array<{ deviceId: string, why: string }>} list @param {Array<{ step: string, ok: boolean, message: string }>} steps
 */
function noteOrphans(list, steps) {
  const fresh = list.filter((x) => x && typeof x.deviceId === 'string' && x.deviceId)
  if (!fresh.length) return
  const known = readOrphans()
  const ids = new Set(known.map((x) => x.deviceId))
  const devices = [...known, ...fresh.filter((x) => !ids.has(x.deviceId)).map((x) => ({ deviceId: x.deviceId, why: x.why, at: Date.now() }))]
  try { fs.mkdirSync(dir(), { recursive: true }); writeJson(orphansFile(), { v: 1, devices }) } catch { /* reported below anyway */ }
  for (const x of fresh) steps.push({ step: 'unused device', ok: true, message: `${x.why}: nobody holds its key; remove it from the Gateway: openclaw devices remove ${x.deviceId}` })
}

/** @returns {{ ok: boolean, steps: Array<{ step: string, ok: boolean, message: string }> }} */
export function uninstall() {
  const ids = [...new Set([...previousDevices(), ...readOrphans().map((x) => x.deviceId)])]
  if (!fs.existsSync(dir())) return { ok: true, steps: [{ step: 'openclaw', ok: true, message: 'nothing to remove' }] }
  fs.rmSync(dir(), { recursive: true, force: true })
  const steps = [{ step: 'files', ok: true, message: `removed ${dir()} (device keys and tokens)` }]
  for (const id of ids) steps.push({ step: 'device', ok: true, message: `the Gateway still lists this device; to revoke it: openclaw devices remove ${id}` })
  return { ok: true, steps }
}

/** Extra doctor lines. @returns {Promise<Array<{ ok: boolean | null, text: string, hint?: string }>>} */
export async function doctor() {
  /** @type {Array<{ ok: boolean | null, text: string, hint?: string }>} */
  const out = []
  // devices an unfinished pairing left in the Gateway (review 3, P5): harmless (nobody has their key), but listed
  const orphans = readOrphans().map((x) => ({ ok: null, text: `OpenClaw: device ${x.deviceId.slice(0, 12)}... (${x.why}) may still be listed in the Gateway`, hint: `openclaw devices remove ${x.deviceId}` }))
  const inst = installed()
  if (!inst.installed) {
    return [inst.legacy
      ? { ok: false, text: 'OpenClaw: paired by an older version with ONE token that can both approve and send messages; it is not used any more', hint: 'npx hinty-agents install openclaw' }
      : { ok: null, text: 'OpenClaw: bridge not paired with the Gateway', hint: 'npx hinty-agents install openclaw' }, ...orphans]
  }
  out.push(...orphans)
  const p = /** @type {NonNullable<ReturnType<typeof readPairing>>} */ (readPairing())
  for (const [name, part, scopes] of /** @type {const} */ ([['approvals', p.approver, APPROVER_SCOPES], ['instructions', p.writer, WRITER_SCOPES]])) {
    if (!part) { out.push({ ok: null, text: 'OpenClaw instructions device: not paired (messages from the glasses are off for OpenClaw)', hint: 'npx hinty-agents install openclaw' }); continue }
    const c = new GatewayClient({ url: p.url, identity: part.identity, deviceToken: part.deviceToken, scopes: [...scopes], connectTimeoutMs: 5000 })
    try {
      await c.connect()
      out.push({ ok: true, text: `OpenClaw Gateway at ${p.url}: ${name} device accepted (protocol ${c.protocol}, ${part.scopes.join(', ')})` })
    } catch (e) {
      out.push({ ok: false, text: `OpenClaw Gateway (${name} device): ${/** @type {Error} */ (e).message}`, hint: 'is it running (openclaw gateway)? token refused: npx hinty-agents install openclaw' })
    } finally { c.close() }
  }
  for (const f of askFallbackFull()) out.push({ ok: null, text: `${f}: askFallback is "full" - OpenClaw allows by itself when nobody answers`, hint: 'set it to deny' })
  return out
}

// ------------------------------------------------------------------------------------------------
// Pure helpers (tested)
// ------------------------------------------------------------------------------------------------

/**
 * The ONLY decisions we ever send (N2). Anything but an explicit allow is a deny.
 * @param {unknown} d @returns {'allow-once' | 'deny'}
 */
export const decisionFor = (d) => (d === 'allow' ? 'allow-once' : 'deny')

/**
 * The fixed first line of every message we send with chat.send (Z1). OpenClaw looks for a command at the start of the
 * message AFTER its own clean-up (stripStructuralPrefixes in OpenClaw 2026.3: `[...]` removed, `label:` at the start of a
 * line removed, a written out `\n` = a space). This line starts with a letter, has no brackets, and has a comma before
 * its colon (a comma is outside OpenClaw's label characters `[A-Za-z0-9+()\-_. ]`), so nothing of it is removed and the
 * message never starts with `/` or `!`.
 */
export const CHAT_PREAMBLE = 'Message from the user, sent from Hinty (glasses or web panel):'

const ZWSP = '\u200b'
/** characters OpenClaw could drop before it looks at the text (it already does for mentions): no layer may rely on them */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu
/**
 * OpenClaw drops everything before `[Current message - respond to this]` (case-sensitive) before it looks for a
 * command. Here matched loosely (any case, any white space, any dash) and broken with a VISIBLE character: its dash
 * becomes an en dash, so no later normalisation (zero-width characters dropped, white space folded) can bring it back
 * (security review 3, P2b).
 */
const CURRENT_MARKER = /current\s+message\s*[\p{Pd}\u2212\ufe63\uff0d]\s*respond\s+to\s+this/giu
const DASHES = /[\p{Pd}\u2212\ufe63\uff0d]/gu
const EN_DASH = '\u2013'
/** a command could start here in what OpenClaw sees: at the start, or after white space (not `//` of a URL) */
const COMMAND_START = /(?:^|\s)(?:\/(?!\/)|!)/u

/**
 * OpenClaw 2026.3.28 `stripStructuralPrefixes` (dist/reply-history-*.js), copied byte for byte: what OpenClaw runs on
 * a message before it looks for `/approve`, `/new`, `/stop`, `!` ... (test/openclaw-strip.test.js keeps its own copy and
 * checks both agree). Used to verify every message before it is sent.
 * @param {string} text
 */
export function openclawStrip(text) {
  if (!text) return ''
  return (text.includes('[Current message - respond to this]') ? text.slice(text.indexOf('[Current message - respond to this]') + 35).trimStart() : text).replace(/\[[^\]]+\]\s*/g, '').replace(/^[ \t]*[A-Za-z0-9+()\-_. ]+:\s*/gm, '').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim()
}

/** @param {string} c a character @param {RegExp} re does it become one of these under compatibility normalisation? */
const becomes = (c, re) => re.test(c.normalize('NFKC'))
const SLASHY = /[/!]/
const BRACKETY = /[[\]]/

/**
 * Is a chat.send message safe as OpenClaw sees it (security review 3, P2a)? After OpenClaw's own clean-up the fixed
 * first line is still at the start and no command can start after it; and the first line also survives when the
 * zero-width characters are dropped first or the text is NFKC-normalised (so the fixed line never depends on them).
 * @param {string} message @returns {boolean}
 */
export function seenAsText(message) {
  const head = openclawStrip(CHAT_PREAMBLE)
  const seen = openclawStrip(message)
  if (!seen.startsWith(head) || COMMAND_START.test(seen.slice(head.length))) return false
  const bare = message.replace(INVISIBLE, '')
  for (const v of [bare, bare.normalize('NFKC'), message.normalize('NFKC')]) if (!openclawStrip(v).startsWith(head)) return false
  return !COMMAND_START.test(openclawStrip(message.normalize('NFKC')).slice(head.length))
}

/**
 * Text for chat.send: plain message (safeInstruction, invisible characters dropped), OpenClaw's "current message" marker
 * broken with a visible character, and a zero-width space before every `/` or `!` that OpenClaw's clean-up could bring
 * to the start of the message or after white space: after the start, white space, `]` (end of a removed `[...]`), `:`
 * (end of a removed `label:`, but not `://` of a URL) or a written out `\n`. Then the result is checked the way OpenClaw
 * will see it (`seenAsText`, with a copy of its clean-up); if a command start could still appear (a text built for
 * the order of OpenClaw's steps, like `\[x]n/approve`), EVERY `/` and `!` gets a zero-width space, and if the fixed
 * line could still be cut, every bracket becomes a parenthesis. Ordinary text, paths and URLs come out unchanged.
 * @param {string} text
 */
export function disarm(text) {
  let t = safeInstruction(String(text ?? '').replace(INVISIBLE, '').replace(/\r\n?/g, '\n'))
  t = t.replace(CURRENT_MARKER, (m) => m.replace(DASHES, EN_DASH))
  t = t.replace(/(^|\s|\]|\\n)([/!])|(:)(?!\/\/)([/!])/gu, (_m, a, b, c, d) => (a !== undefined ? `${a}${ZWSP}${b}` : `${c}${ZWSP}${d}`))
  if (seenAsText(`${CHAT_PREAMBLE}\n${t}`)) return t
  // every / and ! (and what NFKC turns into them) behind a zero-width space
  t = Array.from(t).map((c, i, a) => (becomes(c, SLASHY) && a[i - 1] !== ZWSP ? ZWSP + c : c)).join('')
  if (seenAsText(`${CHAT_PREAMBLE}\n${t}`)) return t
  // the fixed line could still be cut: no bracket left, so no marker and no `[...]` removal
  t = Array.from(t).map((c) => (becomes(c, BRACKETY) ? (c.normalize('NFKC').includes('[') ? '(' : ')') : c)).join('')
  return t
}

/** The whole chat.send message: the fixed first line, then the disarmed text. @param {string} text */
export const chatMessage = (text) => `${CHAT_PREAMBLE}\n${disarm(text)}`

/** @param {unknown} v */
const filled = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)

/** exec request fields that only say where the request came from (not what runs) */
const EXEC_META = ['agentId', 'sessionKey', 'turnSourceChannel', 'turnSourceTo', 'turnSourceAccountId', 'turnSourceThreadId', 'systemRunBinding']
const EXEC_SHOWN = ['command', 'commandPreview', 'commandArgv', 'envKeys', 'systemRunPlan', 'cwd', 'nodeId', 'host', 'security', 'ask', 'resolvedPath', 'warningText']
const PLUGIN_META = ['agentId', 'sessionKey', 'turnSourceChannel', 'turnSourceTo', 'turnSourceAccountId', 'turnSourceThreadId', 'toolCallId']
const PLUGIN_SHOWN = ['title', 'description', 'toolName', 'pluginId', 'severity']

/**
 * The card of an approval request (Z5): every field that changes what runs is on it. Incomplete (`part`) when the
 * command is missing, a run plan we do not render is attached, environment overrides are set (OpenClaw sends only their
 * names, never the values, so the card cannot show what they do), argv is not a list of strings, or the request has a
 * field we do not know. Pure.
 * @param {'exec' | 'plugin'} kind @param {Record<string, any>} req @param {string} tool
 * @returns {{ text: string, complete: boolean }}
 */
export function approvalCard(kind, req, tool) {
  const s = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '')
  /** @param {string[]} known */
  const unknown = (known) => Object.keys(req).filter((k) => !known.includes(k) && filled(req[k]))
  const extra = (/** @type {string[]} */ keys) => (keys.length ? `\nother fields:\n${JSON.stringify(Object.fromEntries(keys.map((k) => [k, req[k]])), null, 2)}` : '')
  if (kind === 'plugin') {
    const other = unknown([...PLUGIN_SHOWN, ...PLUGIN_META])
    const about = [s(req.pluginId) && `plugin: ${s(req.pluginId)}`, s(req.toolName) && `tool: ${s(req.toolName)}`, s(req.severity) && `severity: ${s(req.severity)}`].filter(Boolean).join(', ')
    return { text: `${s(req.title) || tool}${s(req.description) ? `\n${s(req.description)}` : ''}${about ? `\n(${about})` : ''}${extra(other)}`, complete: !other.length }
  }
  let complete = true
  const command = typeof req.command === 'string' ? req.command : null
  if (command === null) complete = false
  const lines = [command ?? '(command)']
  const argv = req.commandArgv
  if (filled(argv)) {
    if (!Array.isArray(argv) || !argv.every((x) => typeof x === 'string')) { complete = false; lines.push(`argv: ${JSON.stringify(argv)}`) } else if (argv.join(' ') !== command) lines.push(`argv: ${JSON.stringify(argv)}`)
  }
  if (s(req.commandPreview).trim() && s(req.commandPreview).trim() !== (command || '').trim()) lines.push(`preview: ${s(req.commandPreview)}`)
  if (filled(req.envKeys)) {
    complete = false
    lines.push(`env: ${Array.isArray(req.envKeys) ? req.envKeys.map((k) => String(k)).join(', ') : JSON.stringify(req.envKeys)} (values not shown)`)
  }
  if (s(req.resolvedPath)) lines.push(`runs: ${s(req.resolvedPath)}`)
  if (s(req.cwd)) lines.push(`cwd: ${s(req.cwd)}`)
  if (s(req.host) && req.host !== 'gateway') lines.push(`host: ${s(req.host)}`)
  if (s(req.nodeId)) lines.push(`node: ${s(req.nodeId)}`)
  const policy = [s(req.security) && `security=${s(req.security)}`, s(req.ask) && `ask=${s(req.ask)}`].filter(Boolean).join(' ')
  if (policy) lines.push(`policy: ${policy}`)
  if (filled(req.systemRunPlan)) { complete = false; lines.push('run plan: (not shown)') }
  if (s(req.warningText)) lines.push(`! ${s(req.warningText)}`)
  const other = unknown([...EXEC_SHOWN, ...EXEC_META])
  if (other.length) complete = false
  return { text: lines.join('\n') + extra(other), complete }
}

/** @param {unknown} content a message's `content`: a string or an array of {type:'text', text} @returns {string} */
export function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((x) => (x && typeof x === 'object' && x.type === 'text' && typeof x.text === 'string' ? x.text : '')).filter(Boolean).join('\n')
}

/** `agent:main:main` -> 'main'; `agent:publisher:telegram:123` -> 'publisher·telegram'. @param {string} key @param {string} [channel] */
export function labelFor(key, channel) {
  const parts = String(key || '').split(':')
  const agentId = parts[0] === 'agent' && parts[1] ? parts[1] : parts[0] || 'openclaw'
  const ch = channel && channel !== 'webchat' ? channel : ''
  return oneLine(ch ? `${agentId}·${ch}` : agentId, 50)
}

/** A session id for the relay: the key itself when it fits (<= 64 printable ASCII, no spaces), else `oc-` + hash. @param {string} key */
export function sidFor(key) {
  return /^[\x21-\x7e]{1,64}$/.test(key) ? key : `oc-${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 20)}`
}

// ------------------------------------------------------------------------------------------------
// The live link
// ------------------------------------------------------------------------------------------------

/**
 * @typedef {import('../service.js').Service} Service
 */

export class OpenClawLink {
  /**
   * @param {{ service: Service, log?: (m: string, f?: Record<string, any>) => void, WebSocketImpl?: any, now?: () => number,
   *   retryMs?: number, sharedToken?: () => string | null }} o
   */
  constructor(o) {
    this.service = o.service
    this.log = o.log || (() => {})
    this.WS = o.WebSocketImpl
    this.now = o.now || Date.now
    this.retryMs = o.retryMs ?? 3000
    /** @type {GatewayClient | null} */
    this.client = null
    this.running = false
    this.generation = 0
    /** @type {any} */
    this.retryTimer = null
    /** sid -> { key, at, label } */
    this.byKey = new Map()
    /** sid -> sessionKey */
    this.keys = new Map()
    /** approval id -> { rid, kind } */
    this.pending = new Map()
    this.canWrite = false
    /** the instructions connection (no operator.approvals), opened at the first `say` while live (Z1) */
    /** @type {GatewayClient | null} */
    this.writer = null
    /** @type {Promise<GatewayClient | null> | null} */
    this.writerP = null
  }

  /** Connect (only if installed). Safe to call again. */
  start() {
    if (this.running) return
    if (!installed().installed) return
    this.running = true
    void this.open(++this.generation)
  }

  stop() {
    this.running = false
    this.generation++
    clearTimeout(this.retryTimer)
    this.dropPending('cancel')
    if (this.client) { const c = this.client; this.client = null; c.removeAllListeners(); c.close() }
    this.closeWriter()
    this.keys.clear()
    this.byKey.clear()
    this.log('oc_stop')
  }

  closeWriter() {
    const w = this.writer
    this.writer = null
    this.writerP = null
    if (w) { w.removeAllListeners(); w.close() }
  }

  /**
   * The connection for chat.send: the writer device (read + write, never approvals). Opened on demand while live,
   * refused when the Gateway says it has `operator.approvals` after all. @returns {Promise<GatewayClient | null>}
   */
  writerClient() {
    if (this.writer && this.writer.connected) return Promise.resolve(this.writer)
    if (this.writerP) return this.writerP
    const p = readPairing()
    if (!p || !p.writer || !this.running) return Promise.resolve(null)
    const gen = this.generation
    const w = new GatewayClient({ url: p.url, identity: p.writer.identity, deviceToken: p.writer.deviceToken, scopes: [...WRITER_SCOPES], WebSocketImpl: this.WS, connectTimeoutMs: 10000, ...(p.protocol ? { protocols: [p.protocol] } : {}) })
    w.on('close', () => { if (this.writer === w) { this.writer = null; this.writerP = null } })
    this.writerP = w.connect().then((hello) => {
      const granted = hello && hello.auth && Array.isArray(hello.auth.scopes) ? hello.auth.scopes : null
      if (gen !== this.generation || !this.running || (granted && granted.includes('operator.approvals'))) {
        if (granted && granted.includes('operator.approvals')) this.log('oc_writer_refused', { why: 'has_approvals' })
        w.removeAllListeners(); w.close(); this.writerP = null
        return null
      }
      this.writer = w
      return w
    }, (e) => {
      this.log('oc_writer_failed', { err: /** @type {Error} */ (e)?.message?.slice(0, 60), code: /** @type {any} */ (e)?.code })
      this.writerP = null
      return null
    })
    return this.writerP
  }

  /** @param {string} why */
  dropPending(why) {
    for (const p of [...this.pending.values()]) this.service.endPerm(p.rid, why)
    this.pending.clear()
  }

  /** @param {number} gen */
  async open(gen) {
    const p = readPairing()
    if (!p) { this.running = false; return }
    // the approvals connection: read + approvals only; it never sends chat text (Z1)
    const c = new GatewayClient({ url: p.url, identity: p.approver.identity, deviceToken: p.approver.deviceToken, scopes: [...APPROVER_SCOPES], WebSocketImpl: this.WS, ...(p.protocol ? { protocols: [p.protocol] } : {}) })
    this.client = c
    // listeners first: events can follow the hello frame immediately
    c.on('event', (f) => { try { this.onEvent(f) } catch (e) { this.log('oc_event_error', { err: /** @type {Error} */ (e)?.name }) } })
    c.on('close', () => { if (gen === this.generation && this.client === c) this.lost() })
    try {
      await c.connect()
      if (gen !== this.generation) { c.close(); return }
      this.canWrite = !!p.writer
      this.log('oc_up', { protocol: c.protocol })
      await this.snapshot(c)
    } catch (e) {
      if (gen !== this.generation) return
      this.log('oc_connect_failed', { err: /** @type {Error} */ (e)?.message?.slice(0, 80), code: /** @type {any} */ (e)?.code })
      this.lost()
    }
  }

  lost() {
    if (!this.running) return
    this.dropPending('cancel')
    if (this.client) { this.client.removeAllListeners(); this.client.close(); this.client = null }
    clearTimeout(this.retryTimer)
    const gen = this.generation
    this.retryTimer = setTimeout(() => { if (this.running && gen === this.generation) void this.open(gen) }, this.retryMs)
    this.retryTimer.unref?.()
  }

  /** @param {GatewayClient} c */
  async snapshot(c) {
    try { await c.request('sessions.subscribe', {}) } catch (e) { this.log('oc_subscribe_failed', { err: /** @type {Error} */ (e).message.slice(0, 60) }) }
    try {
      const r = await c.request('sessions.list', { limit: 30, includeLastMessage: true, activeMinutes: 30 })
      const rows = Array.isArray(r && r.sessions) ? r.sessions : Array.isArray(r) ? r : []
      for (const row of rows.slice(0, MAX_SESSIONS)) this.onSessionRow(row)
    } catch { /* optional */ }
    try {
      // 2026.11+: pending approvals are replayed on request (3.28 refuses: missing scope)
      const r = await c.request('exec.approval.list', {})
      const rows = Array.isArray(r && r.approvals) ? r.approvals : Array.isArray(r && r.items) ? r.items : Array.isArray(r) ? r : []
      for (const row of rows) this.onApproval('exec', row)
    } catch { /* optional */ }
  }

  /** @param {any} f */
  onEvent(f) {
    const p = f.payload || {}
    switch (f.event) {
      case 'exec.approval.requested': return this.onApproval('exec', p)
      case 'plugin.approval.requested': return this.onApproval('plugin', p)
      case 'exec.approval.resolved':
      case 'plugin.approval.resolved': return this.onResolved(p)
      case 'sessions.changed': return this.onChanged(p)
      case 'session.message': return this.onMessage(p)
      case 'agent': return this.onAgent(p)
      case 'chat': return this.onChat(p)
      default:
    }
  }

  // ---- approvals

  /** @param {'exec' | 'plugin'} kind @param {any} p */
  onApproval(kind, p) {
    const approvalId = typeof p.id === 'string' ? p.id : ''
    if (!approvalId || this.pending.has(approvalId)) return
    if (!this.service.hooksLive()) return // N1 / N5: nothing to show, nothing to answer
    const req = (p.request && typeof p.request === 'object' ? p.request : {})
    const expiresAtMs = Number(p.expiresAtMs)
    const ttlS = Math.floor(((Number.isFinite(expiresAtMs) ? expiresAtMs : this.now() + 120000) - this.now()) / 1000) - 5
    if (ttlS < 5) return // too late for a person to answer; OpenClaw's own timeout decides
    const sessionKey = typeof req.sessionKey === 'string' && req.sessionKey ? req.sessionKey : `approval:${req.agentId || 'main'}`
    const sid = sidFor(sessionKey)
    this.keys.set(sid, sessionKey)
    const cwd = typeof req.cwd === 'string' ? req.cwd : ''
    const label = labelFor(sessionKey, typeof req.turnSourceChannel === 'string' ? req.turnSourceChannel : '')
    const tool = kind === 'exec' ? 'exec' : String(req.toolName || req.pluginId || 'plugin')
    // every field that changes what runs is on the card, else the card is incomplete (point 3, review 2 Z5)
    const { text, complete } = approvalCard(kind, req, tool)
    const entry = { rid: '', kind }
    this.pending.set(approvalId, entry)
    const answer = this.service.requestPerm(
      { sid, cwd: '', tool, input: { id: approvalId, command: req.command ?? null, title: req.title ?? null }, agentId: null, agentType: '', cardText: text, cardComplete: complete, label },
      {}, { agent: 'openclaw', ttlMs: ttlS * 1000, onCreate: (perm) => { entry.rid = perm.rid } },
    )
    this.log('oc_perm', { kind })
    answer.then((r) => {
      if (this.pending.get(approvalId) === entry) this.pending.delete(approvalId)
      if (!r || !r.d) return // N1: no decision from a person = we send nothing
      this.resolve(kind, approvalId, decisionFor(r.d))
    }, () => { this.pending.delete(approvalId) })
  }

  /**
   * The single place where a decision leaves for the Gateway (N2).
   * @param {'exec' | 'plugin'} kind @param {string} approvalId @param {'allow-once' | 'deny'} decision
   */
  resolve(kind, approvalId, decision) {
    if (decision !== 'allow-once' && decision !== 'deny') throw new Error('refused decision')
    const c = this.client
    if (!c || !c.connected) { this.log('oc_resolve_skipped'); return }
    c.request(`${kind}.approval.resolve`, { id: approvalId, decision }, 15000).then(
      () => this.log('oc_resolved', { decision }),
      (e) => this.log('oc_resolve_failed', { code: /** @type {any} */ (e).code || String(e.message).slice(0, 60) }),
    )
  }

  /** Someone else (another window) answered, or the request ended. @param {any} p */
  onResolved(p) {
    const approvalId = typeof p.id === 'string' ? p.id : ''
    const e = this.pending.get(approvalId)
    if (!e) return
    this.pending.delete(approvalId)
    this.service.endPerm(e.rid, 'local')
  }

  // ---- sessions

  /** @param {string} key @param {any} s a `session` object or list row @returns {string} */
  channelOf(key, s) {
    return (s && s.deliveryContext && s.deliveryContext.channel) || (s && s.origin && s.origin.provider) || ''
  }

  /**
   * @param {string} key @param {any} s
   * @param {{ st?: import('../sessions.js').SessState, line?: string, answer?: string }} patch
   */
  report(key, s, patch) {
    if (!key) return
    const sid = sidFor(key)
    if (!this.byKey.has(sid) && this.byKey.size >= MAX_SESSIONS) {
      // keep the eight most recently active; the oldest one without an open card is let go
      const open = new Set(this.service.perms.list().map((x) => x.sid))
      const oldest = [...this.byKey.entries()].filter(([k]) => !open.has(k)).sort((a, b) => a[1] - b[1])[0]
      if (!oldest) return
      this.byKey.delete(oldest[0])
      this.keys.delete(oldest[0])
      this.service.endSession(oldest[0])
    }
    this.byKey.set(sid, this.now())
    this.keys.set(sid, key)
    this.service.agentSession('openclaw', { sid, label: labelFor(key, this.channelOf(key, s)), say: this.canWrite, ...patch })
  }

  /** @param {any} row from sessions.list */
  onSessionRow(row) {
    const key = row && (row.key || row.sessionKey)
    if (typeof key !== 'string') return
    const age = this.now() - Number(row.updatedAt || 0)
    if (row.updatedAt && age > ACTIVE_MS) return
    const st = row.status === 'running' ? 'run' : row.status === 'failed' || row.status === 'error' ? 'err' : 'idle'
    const last = typeof row.lastMessagePreview === 'string' ? row.lastMessagePreview : ''
    this.report(key, row, { st, ...(last ? { line: glassesLine(last) } : {}) })
  }

  /** @param {any} p */
  onChanged(p) {
    const key = p.sessionKey
    if (typeof key !== 'string') return
    const s = p.session || {}
    if (p.phase === 'start') return this.report(key, s, { st: 'run' })
    if (p.phase === 'end') {
      const bad = p.status === 'failed' || p.status === 'error' || p.status === 'timeout'
      const idle = p.status === 'aborted' || p.status === 'killed'
      return this.report(key, s, { st: bad ? 'err' : idle ? 'idle' : 'done' })
    }
    if (p.status === 'running') return this.report(key, s, { st: 'run' })
    this.report(key, s, {})
  }

  /** @param {any} p */
  onAgent(p) {
    if (p.stream !== 'lifecycle' || typeof p.sessionKey !== 'string') return
    const phase = p.data && p.data.phase
    if (phase === 'start') this.report(p.sessionKey, null, { st: 'run' })
    else if (phase === 'error') this.report(p.sessionKey, null, { st: 'err' })
  }

  /** @param {any} p */
  onChat(p) {
    if (typeof p.sessionKey !== 'string') return
    if (p.state === 'aborted') this.report(p.sessionKey, null, { st: 'idle' })
    else if (p.state === 'error') this.report(p.sessionKey, null, { st: 'err' })
    else if (p.state === 'final') {
      const text = p.message && p.message.role === 'assistant' ? messageText(p.message.content) : ''
      this.report(p.sessionKey, null, { st: 'done', ...(text ? { line: glassesLine(text), answer: text } : {}) })
    }
  }

  /** @param {any} p */
  onMessage(p) {
    const m = p.message
    if (typeof p.sessionKey !== 'string' || !m || m.role !== 'assistant') return
    const text = messageText(m.content).trim()
    if (!text) return
    this.report(p.sessionKey, p.session, { line: glassesLine(text), answer: text })
  }

  // ---- commands from the glasses

  /**
   * An instruction from the glasses: chat.send over the WRITER connection (never the approvals one), with the fixed first
   * line and the disarmed text (N12, Z1).
   * @param {string} sid @param {string} text already `sayText`ed by the service @returns {Promise<boolean>}
   */
  async say(sid, text) {
    const key = this.keys.get(sid)
    if (!key || !this.client || !this.client.connected || !this.canWrite) return false
    const w = await this.writerClient()
    if (!w || !w.connected || w === this.client) return false
    try {
      await w.request('chat.send', { sessionKey: key, message: chatMessage(text), idempotencyKey: crypto.randomUUID() }, 15000)
      return true
    } catch (e) {
      this.log('oc_say_failed', { err: /** @type {Error} */ (e).message.slice(0, 60) })
      return false
    }
  }
}
