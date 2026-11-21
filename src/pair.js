// @ts-check
// Pairing like a TV: connect without a token, ask for a code, the person types it in the Hinty panel, the server
// hands this computer its bridge token. The token is stored in ~/.hinty-agents/config.json (owner-only) only after the
// person confirmed the account it was paired with (security review point 4: a code typed in by somebody else must not
// tie this computer to their account): `paired {token, bridgeId, account?}`, `account` = the masked e-mail of the
// account that typed the code (e.g. `a***@g***.com`), untrusted text, so it is checked and cleaned before it is shown.
import { io as ioDefault } from 'socket.io-client'
import { oneLine } from './text.js'

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
 * @param {{ api: string, label?: string, host?: string, io?: typeof ioDefault, maxCodes?: number,
 *   onCode: (code: string, expiresIn: number) => void }} o
 * @returns {Promise<{ token: string, bridgeId: string, account: string | null }>}
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
    /** @param {Error | null} err @param {{ token: string, bridgeId: string, account: string | null }} [val] */
    const finish = (err, val) => {
      if (done) return
      done = true
      if (expiry) clearTimeout(expiry)
      s.removeAllListeners()
      s.close()
      if (err) reject(err)
      else resolve(/** @type {any} */ (val))
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
      finish(null, { token: p.token, bridgeId: p.bridgeId, account: cleanAccount(p.account) })
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
