// N9: the local port takes requests only from this computer, only with the secret, never from a browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { createLocalServer, guard, listenLoopback } from '../src/local-http.js'
import { proof } from '../src/crypto.js'

const SECRET = 's'.repeat(43)

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

async function server(extra = {}) {
  let hits = 0
  const s = createLocalServer({
    secret: SECRET,
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

test('N9: no secret, wrong secret, Origin, Sec-Fetch-*, foreign Host = refused before any handler runs', async () => {
  const { s, port, hits } = await server()
  assert.equal((await req(port)).status, 401)
  assert.equal((await req(port, { headers: { 'x-hinty-secret': 'nope' } })).status, 401)
  assert.equal((await req(port, { headers: { 'x-hinty-secret': SECRET, origin: 'https://evil.example' } })).status, 403)
  assert.equal((await req(port, { headers: { 'x-hinty-secret': SECRET, origin: 'null' } })).status, 403)
  assert.equal((await req(port, { headers: { 'x-hinty-secret': SECRET, 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await req(port, { headers: { 'x-hinty-secret': SECRET, host: 'evil.example:80' } })).status, 403)
  assert.equal(hits(), 0)
  const ok = await req(port, { headers: { 'x-hinty-secret': SECRET, 'x-hinty-nonce': 'n1' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(ok.text), { got: { a: 1 } })
  assert.equal(ok.headers['x-hinty-proof'], proof(SECRET, 'n1', ok.text))
  assert.equal(hits(), 1)
  s.close()
})

test('N9: a request from another address is refused (guard), and the port is not reachable from the network', async () => {
  assert.equal(guard({ remoteAddress: '192.168.1.20', headers: { 'x-hinty-secret': SECRET } }, SECRET).reason, 'not_loopback')
  assert.equal(guard({ remoteAddress: '::1', headers: { 'x-hinty-secret': SECRET } }, SECRET).reason, 'not_loopback')
  assert.equal(guard({ remoteAddress: '127.0.0.1', headers: { 'x-hinty-secret': SECRET } }, SECRET), null)
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
  const slow = await req(port, { path: '/v1/slow', headers: { 'x-hinty-secret': SECRET } })
  assert.equal(slow.status, 200)
  const big = await req(port, { headers: { 'x-hinty-secret': SECRET }, body: 'x'.repeat(1024 * 1024 + 10) }).catch((e) => ({ status: e.code }))
  assert.ok(big.status === 413 || big.status === 'ECONNRESET' || big.status === 'EPIPE')
  s.close()
})
