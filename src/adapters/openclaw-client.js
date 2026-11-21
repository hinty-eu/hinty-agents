// @ts-check
// A small client for the OpenClaw Gateway WebSocket (plan E5, docs/podpowiedzi/E5-openclaw-hermes.md section 1.2).
// No dependencies: the built-in WebSocket (Node 22+) and Ed25519 from node:crypto.
//
// Frames are JSON text: {type:'req', id, method, params} / {type:'res', id, ok, payload|error} / {type:'event', event, payload}.
// The Gateway opens with `connect.challenge {nonce, ts}`; we answer with `connect` carrying a signature of that nonce by the
// bridge's own device key, so the first connection from the loopback pairs by itself and gives us a DEVICE TOKEN. That token
// has `operator.write` (it can message every session), so it lives in a 0600 file under $HINTY_AGENTS_HOME/openclaw and is
// never logged and never leaves the computer.
//
// Protocol versions: the Gateway demands exactly its own number (3 in 2026.3.x, 4 from 2026.8). We offer 4 first; on
// `protocol mismatch` the error says which one it speaks (`expectedProtocol`) and we reconnect with that one.
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { VERSION } from '../version.js'

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
/** @param {Buffer} buf */
const b64u = (buf) => buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')

/** The scopes we ask for: read (sessions), write (chat.send) and approvals. Never `operator.admin`. */
export const SCOPES = ['operator.read', 'operator.write', 'operator.approvals']
export const CLIENT_NAME = 'Hinty Agents'

/** @typedef {{ version: 1, deviceId: string, publicKeyPem: string, privateKeyPem: string, createdAtMs: number }} Identity */

/** @param {string} pem */
function rawPublicKey(pem) {
  const spki = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' })
  return spki.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX) ? spki.subarray(SPKI_PREFIX.length) : spki
}

/**
 * The bridge's device identity (Ed25519), created on first use. `create: false` only reads.
 * @param {string} file @param {{ create?: boolean }} [o]
 * @returns {Identity | null}
 */
export function loadIdentity(file, o = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (j && j.version === 1 && j.publicKeyPem && j.privateKeyPem && j.deviceId) return j
  } catch { /* none yet */ }
  if (o.create === false) return null
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  /** @type {Identity} */
  const id = {
    version: 1, deviceId: crypto.createHash('sha256').update(rawPublicKey(publicKeyPem)).digest('hex'),
    publicKeyPem, privateKeyPem, createdAtMs: Date.now(),
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(id, null, 2), { mode: 0o600 })
  return id
}

/**
 * The text a `connect` signs (device auth v3): everything that identifies the client, the scopes, the token and the nonce.
 * @param {{ deviceId: string, clientId: string, mode: string, role: string, scopes: string[], signedAt: number,
 *   token: string, nonce: string, platform: string }} p
 */
export const signPayload = (p) => ['v3', p.deviceId, p.clientId, p.mode, p.role, p.scopes.join(','), String(p.signedAt), p.token, p.nonce, p.platform.toLowerCase(), ''].join('|')

/**
 * @typedef {{ url: string, identity: Identity, scopes?: string[], token?: string, deviceToken?: string,
 *   WebSocketImpl?: any, log?: (m: string, f?: Record<string, any>) => void, requestTimeoutMs?: number,
 *   connectTimeoutMs?: number, protocols?: number[] }} ClientOptions
 */

/** Events: 'event' (a Gateway event frame), 'close' ({code, reason}). */
export class GatewayClient extends EventEmitter {
  /** @param {ClientOptions} o */
  constructor(o) {
    super()
    this.o = o
    this.log = o.log || (() => {})
    this.WS = o.WebSocketImpl || globalThis.WebSocket
    /** @type {any} */
    this.ws = null
    /** @type {any} */
    this.hello = null
    this.protocol = 0
    this.closed = false
    this.seq = 0
    /** @type {Map<string, { res: (v: any) => void, rej: (e: Error) => void, timer: any }>} */
    this.pending = new Map()
  }

  get connected() { return !!this.hello && !this.closed }

  /**
   * Connect and authenticate, negotiating the protocol version. Resolves with `hello-ok`.
   * @returns {Promise<any>}
   */
  async connect() {
    const tried = new Set()
    let proto = (this.o.protocols && this.o.protocols[0]) || 4
    for (let i = 0; i < 3; i++) {
      tried.add(proto)
      try {
        return await this.connectOnce(proto)
      } catch (e) {
        const err = /** @type {any} */ (e)
        const expected = err.expectedProtocol
        if (/protocol mismatch/i.test(String(err.message)) && Number.isInteger(expected) && !tried.has(expected)) {
          proto = expected
          continue
        }
        if (/protocol mismatch/i.test(String(err.message)) && !tried.has(3)) { proto = 3; continue }
        throw err
      }
    }
    throw new Error('protocol negotiation failed')
  }

  /** @param {number} proto */
  connectOnce(proto) {
    return new Promise((resolve, reject) => {
      this.closed = false
      this.hello = null
      let settled = false
      const fail = (/** @type {Error} */ e) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close() } catch { /* closed */ } reject(e) }
      const ws = new this.WS(this.o.url)
      this.ws = ws
      const timer = setTimeout(() => fail(Object.assign(new Error('connect timeout'), { code: 'TIMEOUT' })), this.o.connectTimeoutMs ?? 15000)
      ws.addEventListener('message', (/** @type {any} */ m) => {
        if (this.ws !== ws) return
        let f
        try { f = JSON.parse(String(m.data)) } catch { return }
        if (!f || typeof f !== 'object') return
        if (f.type === 'res') return this.onResponse(f)
        if (f.type !== 'event') return
        if (f.event === 'connect.challenge') {
          if (settled || this.hello) return
          this.sendConnect(proto, f.payload).then((h) => { this.hello = h; this.protocol = Number(h?.protocol) || proto; settled = true; clearTimeout(timer); resolve(h) }, fail)
          return
        }
        this.emit('event', f)
      })
      ws.addEventListener('close', (/** @type {any} */ e) => {
        if (this.ws !== ws) return
        this.closed = true
        const dead = this.pending.size
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.rej(new Error('closed')); this.pending.delete(id) }
        if (!settled) fail(Object.assign(new Error(`closed ${e && e.code}`), { code: 'CLOSED' }))
        this.log('gw_close', { code: e && e.code, pending: dead })
        this.emit('close', { code: e && e.code, reason: String((e && e.reason) || '') })
      })
      ws.addEventListener('error', () => { /* a close follows */ })
    })
  }

  /** @param {number} proto @param {any} challenge */
  async sendConnect(proto, challenge) {
    const nonce = String(challenge?.nonce || '')
    const signedAt = Number.isInteger(challenge?.ts) ? challenge.ts : Date.now()
    const scopes = this.o.scopes || SCOPES
    const id = this.o.identity
    // like OpenClaw's own client: `auth.token` is the shared token, else the stored device token; the signature binds it
    const tokenForSig = this.o.token || this.o.deviceToken || ''
    const platform = process.platform
    const text = signPayload({ deviceId: id.deviceId, clientId: 'cli', mode: 'cli', role: 'operator', scopes, signedAt, token: tokenForSig, nonce, platform })
    const signature = b64u(crypto.sign(null, Buffer.from(text, 'utf8'), crypto.createPrivateKey(id.privateKeyPem)))
    return this.request('connect', {
      minProtocol: proto, maxProtocol: proto,
      client: { id: 'cli', displayName: CLIENT_NAME, version: VERSION, platform, mode: 'cli' },
      role: 'operator', scopes, caps: [],
      auth: { ...(tokenForSig ? { token: tokenForSig } : {}), ...(!this.o.token && this.o.deviceToken ? { deviceToken: this.o.deviceToken } : {}) },
      device: { id: id.deviceId, publicKey: b64u(rawPublicKey(id.publicKeyPem)), signature, signedAt, nonce },
    })
  }

  /** @param {any} f */
  onResponse(f) {
    const p = this.pending.get(f.id)
    if (!p) return
    this.pending.delete(f.id)
    clearTimeout(p.timer)
    if (f.ok) { p.res(f.payload); return }
    const err = f.error || {}
    const e = /** @type {any} */ (new Error(String(err.message || 'error')))
    const d = err.details || {}
    e.code = (d.details && d.details.code) || d.code || err.code || ''
    e.expectedProtocol = d.expectedProtocol ?? (d.details && d.details.expectedProtocol)
    e.canRetryWithDeviceToken = !!(d.details && d.details.canRetryWithDeviceToken)
    p.rej(e)
  }

  /**
   * @param {string} method @param {Record<string, any>} [params] @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  request(method, params = {}, timeoutMs) {
    return new Promise((res, rej) => {
      if (!this.ws || this.closed) { rej(new Error('closed')); return }
      const id = `h${++this.seq}`
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`timeout ${method}`)) }, timeoutMs ?? this.o.requestTimeoutMs ?? 30000)
      this.pending.set(id, { res, rej, timer })
      try { this.ws.send(JSON.stringify({ type: 'req', id, method, params })) } catch (e) { clearTimeout(timer); this.pending.delete(id); rej(/** @type {Error} */ (e)) }
    })
  }

  close() {
    this.closed = true
    try { this.ws && this.ws.close() } catch { /* closed */ }
  }
}
