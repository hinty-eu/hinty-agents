// @ts-check
// Local HTTP port of the service (N9): 127.0.0.1 only, random port, a secret header on every request, and anything
// that looks like a browser (Origin, Sec-Fetch-*) or a foreign Host header is refused. Answers carry a proof
// (HMAC of the caller's nonce and the body) so the hook and the mod know they talk to the real service.
import http from 'node:http'
import { proof, safeEqual } from './crypto.js'

export const SECRET_HEADER = 'x-hinty-secret'
export const NONCE_HEADER = 'x-hinty-nonce'
export const PROOF_HEADER = 'x-hinty-proof'
const MAX_BODY = 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1'])

/**
 * Why a request is refused, or null when it may pass. Exported for tests.
 * @param {{ remoteAddress?: string | null, headers: http.IncomingHttpHeaders }} req @param {string} secret
 * @returns {{ status: number, reason: string } | null}
 */
export function guard(req, secret) {
  if (!LOOPBACK.has(String(req.remoteAddress || ''))) return { status: 403, reason: 'not_loopback' }
  const h = req.headers
  if (h.origin !== undefined) return { status: 403, reason: 'origin' }
  if (h['sec-fetch-site'] !== undefined || h['sec-fetch-mode'] !== undefined || h['sec-fetch-dest'] !== undefined) {
    return { status: 403, reason: 'browser' }
  }
  if (h.host !== undefined && !/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/i.test(String(h.host))) {
    return { status: 403, reason: 'host' }
  }
  if (!safeEqual(h[SECRET_HEADER], secret)) return { status: 401, reason: 'secret' }
  return null
}

/**
 * @typedef {(body: any, ctl: { onAbort: (fn: () => void) => void }) => any} Handler
 * @param {{ secret: string, routes: Record<string, Handler>, log?: (m: string, f?: Record<string, any>) => void }} o
 * @returns {http.Server}
 */
export function createLocalServer(o) {
  const log = o.log || (() => {})
  const server = http.createServer((req, res) => {
    const deny = guard({ remoteAddress: req.socket.remoteAddress, headers: req.headers }, o.secret)
    if (deny) {
      log('http_refused', { reason: deny.reason })
      res.writeHead(deny.status, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ error: deny.reason }))
      req.resume()
      return
    }
    const key = `${req.method} ${String(req.url || '').split('?')[0]}`
    const route = o.routes[key]
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not_found"}')
      req.resume()
      return
    }
    const nonce = String(req.headers[NONCE_HEADER] || '').slice(0, 128)
    let size = 0
    /** @type {Buffer[]} */
    const chunks = []
    let tooBig = false
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { tooBig = true; return }
      chunks.push(c)
    })
    req.on('end', async () => {
      if (tooBig) {
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' })
        res.end('{"error":"too_big"}')
        return
      }
      let body = null
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw) { try { body = JSON.parse(raw) } catch { body = null } }
      /** @type {Array<() => void>} */
      const aborts = []
      res.on('close', () => { if (!res.writableEnded) for (const fn of aborts) { try { fn() } catch { /* ignore */ } } })
      let out
      try {
        out = await route(body, { onAbort: (fn) => aborts.push(fn) })
      } catch (e) {
        log('http_error', { route: key, err: /** @type {Error} */ (e)?.name || 'error' })
        out = { error: 'internal' }
      }
      if (res.destroyed || res.writableEnded) return
      const text = JSON.stringify(out ?? {})
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        [PROOF_HEADER]: proof(o.secret, nonce, text),
      })
      res.end(text)
    })
  })
  server.requestTimeout = 30000
  server.headersTimeout = 10000
  server.keepAliveTimeout = 1000
  return server
}

/**
 * Listen on 127.0.0.1 and a random free port.
 * @param {http.Server} server @returns {Promise<number>}
 */
export function listenLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const a = server.address()
      resolve(typeof a === 'object' && a ? a.port : 0)
    })
  })
}
