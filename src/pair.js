// @ts-check
// Pairing like a TV: connect without a token, ask for a code, the person types it in the Hinty panel, the server
// hands this computer its bridge token. The token is stored in ~/.hinty-agents/config.json (owner-only).
import { io as ioDefault } from 'socket.io-client'

/**
 * @param {{ api: string, label?: string, host?: string, io?: typeof ioDefault, maxCodes?: number,
 *   onCode: (code: string, expiresIn: number) => void }} o
 * @returns {Promise<{ token: string, bridgeId: string }>}
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
    /** @param {Error | null} err @param {{ token: string, bridgeId: string }} [val] */
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
      if (!p || typeof p.code !== 'string') return
      const expiresIn = Number(p.expiresIn) || 600
      o.onCode(p.code, expiresIn)
      if (expiry) clearTimeout(expiry)
      expiry = setTimeout(ask, expiresIn * 1000)
    })
    s.on('paired', (/** @type {any} */ p) => {
      if (!p || typeof p.token !== 'string' || p.token.length < 16 || typeof p.bridgeId !== 'string') {
        return finish(new Error('bad_pairing_answer'))
      }
      finish(null, { token: p.token, bridgeId: p.bridgeId })
    })
    s.on('pair_error', (/** @type {any} */ p) => finish(new Error(`pair_error:${p && p.reason}`)))
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
