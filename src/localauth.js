// @ts-check
// Local protocol v2 (N9, security review point 1). The key in daemon.json NEVER travels: every request to the service's
// 127.0.0.1 port carries an HMAC-SHA256 of a one-time nonce, a timestamp, the method, the path and the SHA-256 of the body,
// and every 200 answer carries an HMAC of the request's nonce, the status and the SHA-256 of the answer's body. A process
// that grabbed a stale port can neither answer for the service nor replay a request later, and since review 2 (Z6) the
// hooks, the mod and the Hermes plugin send content only after a signed /v1/ping that names the pid of daemon.json.
//
// The same scheme is written out four more times, because those clients cannot import this file:
//   claude-plugin/hook.cjs, hooks/common.cjs (Codex, Grok), claude-plugin/hooks/register.mjs (the mod, crypto.subtle only),
//   hermes-plugin/hinty-agents/__init__.py (Python). test/localauth.test.js checks all of them against this one.
//
//   request  x-hinty-pv: 2, x-hinty-ts: <ms>, x-hinty-nonce: <32 hex>,
//            x-hinty-auth: HMAC(key, "hinty-req\n2\n" + ts + "\n" + nonce + "\n" + METHOD + "\n" + path + "\n" + sha256hex(body))
//   answer   x-hinty-sig:  HMAC(key, "hinty-res\n2\n" + nonce + "\n" + status + "\n" + sha256hex(answer body))
//
// A client accepts only status 200 with a correct `x-hinty-sig`; anything else is an empty result (N1). daemon.json says
// `pv: 2` and holds the key as `key` (no `secret` field): a client of another version finds nothing it understands and
// gives an empty result instead of sending anything.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const PV = 2
/** a request older or newer than this (same computer, same clock) is refused */
export const WINDOW_MS = 30 * 1000
export const H = { pv: 'x-hinty-pv', ts: 'x-hinty-ts', nonce: 'x-hinty-nonce', auth: 'x-hinty-auth', sig: 'x-hinty-sig' }
export const NONCE_RE = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/

/** @param {string | Buffer | Uint8Array} b */
export const sha256Hex = (b) => createHash('sha256').update(typeof b === 'string' ? Buffer.from(b, 'utf8') : b).digest('hex')
/** @param {string} key @param {string} msg */
export const hmacHex = (key, msg) => createHmac('sha256', key).update(msg, 'utf8').digest('hex')

/** @param {string | number} ts @param {string} nonce @param {string} method @param {string} path @param {string} bodySha */
export const reqMessage = (ts, nonce, method, path, bodySha) => `hinty-req\n${PV}\n${ts}\n${nonce}\n${method}\n${path}\n${bodySha}`
/** @param {string} nonce @param {number} status @param {string} bodySha */
export const resMessage = (nonce, status, bodySha) => `hinty-res\n${PV}\n${nonce}\n${status}\n${bodySha}`

/**
 * Headers of a signed request.
 * @param {string} key @param {string} method @param {string} path @param {string | Buffer} body
 * @param {{ now?: number, nonce?: string }} [o]
 */
export function signRequest(key, method, path, body, o = {}) {
  const nonce = o.nonce || randomBytes(16).toString('hex')
  const ts = String(o.now ?? Date.now())
  return {
    nonce,
    headers: {
      [H.pv]: String(PV), [H.ts]: ts, [H.nonce]: nonce,
      [H.auth]: hmacHex(key, reqMessage(ts, nonce, method, path, sha256Hex(body))),
    },
  }
}

/** @param {string} key @param {string} nonce @param {number} status @param {string | Buffer} body */
export const responseSig = (key, nonce, status, body) => hmacHex(key, resMessage(nonce, status, sha256Hex(body)))

/**
 * Constant-time comparison of two hex strings (different lengths are simply unequal).
 * @param {unknown} a @param {unknown} b
 */
export function hexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const A = Buffer.from(a, 'utf8')
  const B = Buffer.from(b, 'utf8')
  return A.length === B.length && timingSafeEqual(A, B)
}

/**
 * The header part of the check, before the body is read: version, time window, nonce and signature format.
 * @param {Record<string, string | string[] | undefined>} h @param {number} now
 * @returns {string | null} why it is refused, or null
 */
export function headerProblem(h, now) {
  if (h[H.pv] !== String(PV)) return 'version'
  const ts = String(h[H.ts] || '')
  if (!/^\d{10,16}$/.test(ts) || Math.abs(now - Number(ts)) > WINDOW_MS) return 'stale'
  if (!NONCE_RE.test(String(h[H.nonce] || ''))) return 'nonce'
  if (!HEX64.test(String(h[H.auth] || ''))) return 'auth'
  return null
}

/**
 * Does the signature cover exactly this request?
 * @param {string} key @param {Record<string, string | string[] | undefined>} h @param {string} method @param {string} path @param {Buffer} body
 */
export const requestValid = (key, h, method, path, body) =>
  hexEqual(h[H.auth], hmacHex(key, reqMessage(String(h[H.ts]), String(h[H.nonce]), method, path, sha256Hex(body))))

/** Nonces seen inside the time window: a replayed request is refused. */
export class NonceCache {
  /** @param {{ windowMs?: number, max?: number }} [o] */
  constructor(o = {}) {
    this.windowMs = (o.windowMs ?? WINDOW_MS) * 2
    this.max = o.max ?? 100000
    /** @type {Map<string, number>} nonce -> time it may be forgotten */
    this.seen = new Map()
  }

  /** @param {number} now */
  sweep(now) {
    for (const [n, until] of this.seen) if (until <= now) this.seen.delete(n)
  }

  /**
   * Record a nonce; false when it was already used (or the table is full, which no honest client can cause).
   * @param {string} nonce @param {number} now
   */
  use(nonce, now) {
    if (this.seen.size > 1000) this.sweep(now)
    const until = this.seen.get(nonce)
    if (until !== undefined && until > now) return false
    if (this.seen.size >= this.max) return false
    this.seen.set(nonce, now + this.windowMs)
    return true
  }
}

/**
 * daemon.json of protocol v2. Used by the service and by the tests' fake services.
 * @param {{ pid: number, port: number, key: string, startedAt?: string, version?: string }} o
 */
export const daemonRecord = (o) => ({ v: 2, pv: PV, pid: o.pid, port: o.port, key: o.key, startedAt: o.startedAt || new Date().toISOString(), version: o.version || '' })
