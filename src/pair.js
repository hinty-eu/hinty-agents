// @ts-check
// Pairing like a TV: connect without a token, ask for a code, the person types it in the Hinty panel, the server
// hands this computer its bridge token. The token is stored in ~/.hinty-agents/config.json (owner-only) only after the
// person proved that the code went into THEIR panel (security review point 4, review 2 Z10: a code read off a shared
// screen and typed into somebody else's account must not tie this computer to that account):
// `paired {token, bridgeId, account?, checkHash}`. The panel that typed the code shows a 4-digit number (`check`, only
// in the answer of `POST /agents-link/claim`); the bridge gets `checkHash = sha256(token + ":" + check)` and asks the
// person to type the number they see. Only the account that typed the code can see it. `account` (the masked e-mail,
// e.g. `a***@g***.com`) is shown as extra information; it is untrusted text, checked and cleaned before it is shown.
import crypto from 'node:crypto'
import { io as ioDefault } from 'socket.io-client'
import { oneLine } from './text.js'

/**
 * Is `typed` the number shown in the panel? sha256(token + ":" + typed) against `checkHash`, compared in constant time.
 * Only 4 digits count. Pure.
 * @param {string} token @param {string | null} checkHash @param {unknown} typed
 */
export function checkMatches(token, checkHash, typed) {
  const t = String(typed ?? '').trim()
  if (!checkHash || !/^[0-9a-f]{64}$/.test(checkHash) || !/^\d{4}$/.test(t)) return false
  const got = crypto.createHash('sha256').update(`${token}:${t}`, 'utf8').digest()
  return crypto.timingSafeEqual(got, Buffer.from(checkHash, 'hex'))
}

export const CHECK_TRIES = 3

/** The code alphabet of the server (kontrakt-v2 `pair_code`): 6 characters, no 0/O/1/I/L/B/8/S/5/2/Z. */
export const CODE_RE = /^[ACDEFGHJKMNPQRTUVWXY34679]{6}$/

/**
 * The masked account from `paired`, cleaned for a terminal; null when absent or not shaped like a masked e-mail.
 * @param {unknown} v @returns {string | null}
 */
export function cleanAccount(v) {
  if (typeof v !== 'string') return null
  const a = oneLine(v, 60)
  return /^[^\s@]{1,30}@[^\s@]{1,40}$/.test(a) ? a : null
}

/**
 * @param {{ api: string, label?: string, host?: string, io?: typeof ioDefault, maxCodes?: number, signal?: AbortSignal,
 *   onCode: (code: string, expiresIn: number) => void }} o
 *   signal: aborting it closes the connection and rejects with `cancelled` (the desktop app's Cancel button)
 * @returns {Promise<{ token: string, bridgeId: string, account: string | null, checkHash: string | null }>}
 */
export function pair(o) {
  const io = o.io || ioDefault
  const maxCodes = o.maxCodes ?? 3
  return new Promise((resolve, reject) => {
    let codes = 0
    /** @type {any} */
    let expiry = null
    let done = false
    const s = io(`${o.api.replace(/\/+$/, '')}/agents-link`, {
      transports: ['websocket'], auth: {}, reconnection: true, reconnectionAttempts: 5, forceNew: true, timeout: 15000,
    })
    /** @param {Error | null} err @param {{ token: string, bridgeId: string, account: string | null, checkHash: string | null }} [val] */
    const finish = (err, val) => {
      if (done) return
      done = true
      if (expiry) clearTimeout(expiry)
      s.removeAllListeners()
      s.close()
      if (err) reject(err)
      else resolve(/** @type {any} */ (val))
    }
    if (o.signal) {
      if (o.signal.aborted) return finish(new Error('cancelled'))
      o.signal.addEventListener('abort', () => finish(new Error('cancelled')), { once: true })
    }
    const ask = () => {
      if (codes >= maxCodes) return finish(new Error('pairing_timeout'))
      codes++
      s.emit('pair_start', { label: (o.label || '').slice(0, 60), host: (o.host || '').slice(0, 60) })
    }
    s.on('connect', ask)
    s.on('pair_code', (/** @type {any} */ p) => {
      // only a code of the server's alphabet is ever printed (no terminal escapes from the network)
      if (!p || typeof p.code !== 'string' || !CODE_RE.test(p.code)) return
      const expiresIn = Math.min(Math.max(Number(p.expiresIn) || 600, 30), 3600)
      o.onCode(p.code, expiresIn)
      if (expiry) clearTimeout(expiry)
      expiry = setTimeout(ask, expiresIn * 1000)
    })
    s.on('paired', (/** @type {any} */ p) => {
      if (!p || typeof p.token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(p.token) ||
        typeof p.bridgeId !== 'string' || !/^[0-9a-f]{24}$/.test(p.bridgeId)) {
        return finish(new Error('bad_pairing_answer'))
      }
      const checkHash = typeof p.checkHash === 'string' && /^[0-9a-f]{64}$/.test(p.checkHash) ? p.checkHash : null
      finish(null, { token: p.token, bridgeId: p.bridgeId, account: cleanAccount(p.account), checkHash })
    })
    s.on('pair_error', (/** @type {any} */ p) => finish(new Error(`pair_error:${oneLine(p && p.reason, 30)}`)))
    s.on('connect_error', (err) => {
      const msg = String(err && err.message || '')
      if (['off', 'not_allowed', 'unauthorized', 'ambiguous', 'invalid_token'].includes(msg)) finish(new Error(`refused:${msg}`))
    })
    s.io.on('reconnect_failed', () => finish(new Error('unreachable')))
    // the server closes a token-less socket after 11 minutes: open a new one (it asks for a new code)
    s.on('disconnect', (reason) => { if (!done && reason === 'io server disconnect') { if (expiry) clearTimeout(expiry); s.connect() } })
  })
}

/** "ACD4FG" -> "ACD-4FG" */
export const prettyCode = (/** @type {string} */ c) => (c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c)
