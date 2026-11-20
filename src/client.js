// @ts-check
// Talks to the running service over its local port (CLI side). Checks the answer's proof like the hook does.
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { proof, safeEqual } from './crypto.js'
import { NONCE_HEADER, PROOF_HEADER, SECRET_HEADER } from './local-http.js'
import { readDaemonInfo } from './store.js'

/**
 * @param {string} method @param {string} path @param {unknown} [body]
 * @param {{ timeoutMs?: number, info?: import('./store.js').DaemonInfo | null }} [o]
 * @returns {Promise<any>} parsed answer; rejects when the service is not running or the answer is not proven
 */
export function call(method, path, body, o = {}) {
  const info = o.info === undefined ? readDaemonInfo() : o.info
  if (!info) return Promise.reject(Object.assign(new Error('not_running'), { code: 'NOT_RUNNING' }))
  const nonce = randomBytes(16).toString('hex')
  const payload = body === undefined ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: info.port, path, method, agent: false,
      headers: {
        [SECRET_HEADER]: info.secret, [NONCE_HEADER]: nonce, connection: 'close',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Object.assign(new Error(`http_${res.statusCode}`), { code: 'HTTP' }))
        if (!safeEqual(res.headers[PROOF_HEADER], proof(info.secret, nonce, text))) {
          return reject(Object.assign(new Error('bad_proof'), { code: 'BAD_PROOF' }))
        }
        try { resolve(JSON.parse(text)) } catch { reject(new Error('bad_json')) }
      })
    })
    req.setTimeout(o.timeoutMs ?? 5000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })))
    req.on('error', (e) => reject(Object.assign(e, { code: /** @type {any} */ (e).code === 'ECONNREFUSED' ? 'NOT_RUNNING' : /** @type {any} */ (e).code })))
    req.end(payload)
  })
}

/** @returns {Promise<any | null>} the status, or null when the service does not answer */
export async function status() {
  try { return await call('GET', '/v1/status') } catch { return null }
}
