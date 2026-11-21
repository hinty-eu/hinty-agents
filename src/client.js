// @ts-check
// Talks to the running service over its local port (CLI side): signed requests, signed answers (protocol v2,
// src/localauth.js), like the hooks and the mod.
import http from 'node:http'
import { H, hexEqual, responseSig, signRequest } from './localauth.js'
import { readDaemonInfo } from './store.js'

/**
 * @param {string} method @param {string} path @param {unknown} [body]
 * @param {{ timeoutMs?: number, info?: import('./store.js').DaemonInfo | null }} [o]
 * @returns {Promise<any>} parsed answer; rejects when the service is not running or the answer is not signed by it
 */
export function call(method, path, body, o = {}) {
  const info = o.info === undefined ? readDaemonInfo() : o.info
  if (!info) return Promise.reject(Object.assign(new Error('not_running'), { code: 'NOT_RUNNING' }))
  const payload = Buffer.from(body === undefined ? '' : JSON.stringify(body), 'utf8')
  const { nonce, headers } = signRequest(info.key, method, path, payload)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: info.port, path, method, agent: false,
      headers: {
        ...headers, connection: 'close',
        ...(payload.length ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (res) => {
      /** @type {Buffer[]} */
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Object.assign(new Error(`http_${res.statusCode}`), { code: 'HTTP' }))
        const raw = Buffer.concat(chunks)
        if (!hexEqual(res.headers[H.sig], responseSig(info.key, nonce, 200, raw))) {
          return reject(Object.assign(new Error('bad_signature'), { code: 'BAD_PROOF' }))
        }
        try { resolve(JSON.parse(raw.toString('utf8'))) } catch { reject(new Error('bad_json')) }
      })
    })
    req.setTimeout(o.timeoutMs ?? 5000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })))
    req.on('error', (e) => reject(Object.assign(e, { code: /** @type {any} */ (e).code === 'ECONNREFUSED' ? 'NOT_RUNNING' : /** @type {any} */ (e).code })))
    req.end(payload.length ? payload : undefined)
  })
}

/** @returns {Promise<any | null>} the status, or null when the service does not answer */
export async function status() {
  try { return await call('GET', '/v1/status') } catch { return null }
}

/**
 * Is the process in daemon.json really our service? Only a signed answer of /v1/ping with the same pid says so.
 * @param {import('./store.js').DaemonInfo} info @returns {Promise<boolean>}
 */
export async function pingOwn(info) {
  try {
    const r = await call('GET', '/v1/ping', undefined, { info, timeoutMs: 2000 })
    return !!r && r.ok === true && r.pid === info.pid
  } catch { return false }
}
