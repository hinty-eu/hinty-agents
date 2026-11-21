// N9 + security review point 1: the local port takes requests only from this computer, only signed with the key from
// daemon.json (the key itself never travels), never from a browser; a replayed or stale request is refused; every 200
// answer is signed over the request's nonce.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { createLocalServer, guard, listenLoopback } from '../src/local-http.js'
import { H, responseSig, signRequest, NonceCache, WINDOW_MS } from '../src/localauth.js'

const KEY = 's'.repeat(43)

function req(port, { method = 'POST', path = '/v1/echo', headers = {}, body = '{"a":1}' } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, agent: false, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    r.on('error', reject)
    r.end(body)
  })
}
const signed = (o = {}) => signRequest(o.key || KEY, o.method || 'POST', o.path || '/v1/echo', o.body ?? '{"a":1}', o)

async function server(extra = {}) {
  let hits = 0
  const s = createLocalServer({
    key: KEY,
    routes: {
      'POST /v1/echo': (body) => { hits++; return { got: body } },
      'POST /v1/slow': async () => { hits++; await new Promise((r) => setTimeout(r, 800)); return { slow: true } },
    },
  })
  Object.assign(s, extra)
  const port = await listenLoopback(s)
  return { s, port, hits: () => hits }
}

test('N9: bound to 127.0.0.1 on a random port', async () => {
  const { s, port } = await server()
  assert.equal(s.address().address, '127.0.0.1')
  assert.ok(port > 1024)
  s.close()
})

test('v2: unsigned, wrongly signed, old-style secret header, Origin, Sec-Fetch-*, foreign Host = refused before any handler runs', async () => {
  const { s, port, hits } = await server()
  assert.equal((await req(port)).status, 401)
  assert.equal((await req(port, { headers: { 'x-hinty-secret': KEY } })).status, 401, 'the old protocol (secret in a header) is not accepted')
  assert.equal((await req(port, { headers: signed({ key: 'w'.repeat(43) }).headers })).status, 401, 'another key')
  const ok = signed()
  assert.equal((await req(port, { headers: { ...ok.headers, origin: 'https://evil.example' } })).status, 403)
  assert.equal((await req(port, { headers: { ...signed().headers, origin: 'null' } })).status, 403)
  assert.equal((await req(port, { headers: { ...signed().headers, 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await req(port, { headers: { ...signed().headers, host: 'evil.example:80' } })).status, 403)
  assert.equal(hits(), 0)
  const good = signed()
  const r = await req(port, { headers: good.headers })
  assert.equal(r.status, 200)
  assert.deepEqual(JSON.parse(r.text), { got: { a: 1 } })
  assert.equal(r.headers[H.sig], responseSig(KEY, good.nonce, 200, r.text))
  assert.equal(r.headers['x-hinty-proof'], undefined)
  assert.equal(hits(), 1)
  s.close()
})

test('v2: the signature covers method, path and body; a replay and a stale or future timestamp are refused', async () => {
  const { s, port, hits } = await server()
  // body changed after signing
  assert.equal((await req(port, { headers: signed().headers, body: '{"a":2}' })).status, 401)
  // signed for another path or method
  assert.equal((await req(port, { headers: signed({ path: '/v1/slow' }).headers })).status, 401)
  assert.equal((await req(port, { headers: signed({ method: 'GET' }).headers })).status, 401)
  // replay of a good request
  const once = signed()
  assert.equal((await req(port, { headers: once.headers })).status, 200)
  const again = await req(port, { headers: once.headers })
  assert.deepEqual([again.status, JSON.parse(again.text).error], [401, 'replay'])
  // outside the 30 s window
  assert.equal(JSON.parse((await req(port, { headers: signed({ now: Date.now() - WINDOW_MS - 2000 }).headers })).text).error, 'stale')
  assert.equal(JSON.parse((await req(port, { headers: signed({ now: Date.now() + WINDOW_MS + 2000 }).headers })).text).error, 'stale')
  // another protocol version
  assert.equal(JSON.parse((await req(port, { headers: { ...signed().headers, [H.pv]: '1' } })).text).error, 'version')
  assert.equal(hits(), 1)
  s.close()
})

test('N9: a request from another address is refused (guard), and the port is not reachable from the network', async () => {
  const h = signed().headers
  assert.equal(guard({ remoteAddress: '192.168.1.20', headers: h }).reason, 'not_loopback')
  assert.equal(guard({ remoteAddress: '::1', headers: h }).reason, 'not_loopback')
  assert.equal(guard({ remoteAddress: '127.0.0.1', headers: h }), null)
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)
  if (!lan) return
  const { s, port } = await server()
  const reached = await new Promise((resolve) => {
    const c = net.connect({ host: lan.address, port }, () => { c.destroy(); resolve(true) })
    c.on('error', () => resolve(false))
    c.setTimeout(2000, () => { c.destroy(); resolve(false) })
  })
  assert.equal(reached, false, `port reachable on ${lan.address}`)
  s.close()
})

test('a held answer outlives the request-receive timeout; oversized bodies are refused', async () => {
  const { s, port } = await server({ requestTimeout: 300 })
  const slow = await req(port, { path: '/v1/slow', headers: signed({ path: '/v1/slow' }).headers })
  assert.equal(slow.status, 200)
  const body = 'x'.repeat(1024 * 1024 + 10)
  const big = await req(port, { headers: signed({ body }).headers, body }).catch((e) => ({ status: e.code }))
  assert.ok(big.status === 413 || big.status === 'ECONNRESET' || big.status === 'EPIPE')
  s.close()
})

test('nonce cache: a nonce counts once inside the window, is forgotten after it', () => {
  const c = new NonceCache({ windowMs: 1000 })
  assert.equal(c.use('a'.repeat(32), 0), true)
  assert.equal(c.use('a'.repeat(32), 500), false)
  assert.equal(c.use('a'.repeat(32), 2500), true)
})
