// @ts-check
// Local HTTP port of the service (N9): 127.0.0.1 only, random port. Anything that looks like a browser (Origin,
// Sec-Fetch-*) or carries a foreign Host header is refused, and every request must be signed with the key from
// daemon.json (protocol v2, src/localauth.js): the key itself never travels. A 200 answer is signed over the request's
// nonce, so the hook, the mod, the CLI and the Hermes plugin know they talk to the real service.
import http from 'node:http'
import { H, NonceCache, PV, headerProblem, requestValid, responseSig } from './localauth.js'

const MAX_BODY = 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1'])

/**
 * Why a request is refused before its body is read, or null when it may go on. Exported for tests.
 * @param {{ remoteAddress?: string | null, headers: http.IncomingHttpHeaders }} req @param {number} [now]
 * @returns {{ status: number, reason: string } | null}
 */
export function guard(req, now = Date.now()) {
  if (!LOOPBACK.has(String(req.remoteAddress || ''))) return { status: 403, reason: 'not_loopback' }
  const h = req.headers
  if (h.origin !== undefined) return { status: 403, reason: 'origin' }
  if (h['sec-fetch-site'] !== undefined || h['sec-fetch-mode'] !== undefined || h['sec-fetch-dest'] !== undefined) {
    return { status: 403, reason: 'browser' }
  }
  if (h.host !== undefined && !/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/i.test(String(h.host))) {
    return { status: 403, reason: 'host' }
  }
  const bad = headerProblem(h, now)
  if (bad) return { status: 401, reason: bad }
  return null
}

/**
 * @typedef {(body: any, ctl: { onAbort: (fn: () => void) => void }) => any} Handler
 * @param {{ key: string, routes: Record<string, Handler>, log?: (m: string, f?: Record<string, any>) => void, now?: () => number }} o
 * @returns {http.Server}
 */
export function createLocalServer(o) {
  const log = o.log || (() => {})
  const now = o.now || Date.now
  const nonces = new NonceCache()
  /** @param {http.ServerResponse} res @param {number} status @param {string} reason */
  const refuse = (res, status, reason) => {
    log('http_refused', { reason })
    res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify({ error: reason }))
  }
  const server = http.createServer((req, res) => {
    const deny = guard({ remoteAddress: req.socket.remoteAddress, headers: req.headers }, now())
    if (deny) { refuse(res, deny.status, deny.reason); req.resume(); return }
    const url = String(req.url || '')
    const key = `${req.method} ${url.split('?')[0]}`
    const route = o.routes[key]
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not_found"}')
      req.resume()
      return
    }
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
      if (tooBig) { refuse(res, 413, 'too_big'); return }
      const raw = Buffer.concat(chunks)
      // the signature covers this exact method, path (with any query) and body; each nonce counts once
      if (!requestValid(o.key, req.headers, String(req.method), url, raw)) { refuse(res, 401, 'auth'); return }
      const nonce = String(req.headers[H.nonce])
      if (!nonces.use(nonce, now())) { refuse(res, 401, 'replay'); return }
      let body = null
      const text = raw.toString('utf8')
      if (text) { try { body = JSON.parse(text) } catch { body = null } }
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
      const answer = Buffer.from(JSON.stringify(out ?? {}), 'utf8')
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'content-length': answer.length,
        [H.pv]: String(PV),
        [H.sig]: responseSig(o.key, nonce, 200, answer),
      })
      res.end(answer)
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
