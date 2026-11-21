// A fake OpenClaw Gateway for tests: the WebSocket framing, the challenge / connect handshake with a real check of the
// Ed25519 signature, protocol negotiation (`protocol mismatch` + expectedProtocol), device-token issue, and a hook for
// the test to push events and see every request the bridge sends.
import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'
import { signPayload } from '../../src/adapters/openclaw-client.js'

const b64uToBuf = (s) => Buffer.from(s.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export async function startGateway({ protocol = 3, sharedToken = 'shared-token-AAAA', deviceToken = 'device-token-SECRET', scopes = ['operator.read', 'operator.write', 'operator.approvals'], rejectDeviceToken = false } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((r) => wss.once('listening', r))
  const port = wss.address().port
  /** @type {Set<any>} */
  const sockets = new Set()
  const gw = {
    port, url: `ws://127.0.0.1:${port}`, sockets, requests: [], connects: [], tokensSeen: [],
    /** how a request is answered: method -> (params) => payload | throws {message, code} */
    handlers: {},
    emit(event, payload) { for (const s of sockets) if (s.authed) s.send(JSON.stringify({ type: 'event', event, payload })) },
    get clients() { return [...sockets].filter((s) => s.authed).length },
    async close() { for (const s of sockets) s.terminate(); await new Promise((r) => wss.close(r)) },
  }
  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.authed = false
    ws.on('close', () => sockets.delete(ws))
    const nonce = crypto.randomBytes(8).toString('hex')
    const ts = Date.now()
    ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce, ts } }))
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw))
      if (f.type !== 'req') return
      const reply = (ok, payloadOrError) => ws.send(JSON.stringify(ok ? { type: 'res', id: f.id, ok: true, payload: payloadOrError } : { type: 'res', id: f.id, ok: false, error: payloadOrError }))
      if (f.method === 'connect') {
        const p = f.params
        gw.connects.push(p)
        gw.tokensSeen.push(p.auth && p.auth.token)
        if (p.minProtocol !== protocol || p.maxProtocol !== protocol) {
          return reply(false, { message: 'protocol mismatch', details: { expectedProtocol: protocol } })
        }
        // check the signature the way the Gateway does
        const raw32 = b64uToBuf(p.device.publicKey)
        const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw32]), format: 'der', type: 'spki' })
        const text = signPayload({ deviceId: p.device.id, clientId: p.client.id, mode: p.client.mode, role: p.role, scopes: p.scopes, signedAt: p.device.signedAt, token: (p.auth && p.auth.token) || '', nonce, platform: p.client.platform })
        const sigOk = crypto.verify(null, Buffer.from(text, 'utf8'), key, b64uToBuf(p.device.signature))
        const idOk = crypto.createHash('sha256').update(raw32).digest('hex') === p.device.id
        const tokenOk = p.auth && (p.auth.token === sharedToken || (!rejectDeviceToken && p.auth.token === deviceToken))
        if (!sigOk || !idOk || p.device.nonce !== nonce) return reply(false, { message: 'device signature invalid', details: { details: { code: 'DEVICE_AUTH_INVALID' } } })
        if (!tokenOk) return reply(false, { message: 'unauthorized', details: { details: { code: 'AUTH_TOKEN_MISMATCH', canRetryWithDeviceToken: false } } })
        ws.authed = true
        return reply(true, { type: 'hello-ok', protocol, server: { version: 'fake-1', connId: 'c1' }, auth: { deviceToken, role: 'operator', scopes: p.scopes, issuedAtMs: Date.now() } })
      }
      if (!ws.authed) return reply(false, { message: 'not connected' })
      gw.requests.push({ method: f.method, params: f.params })
      const h = gw.handlers[f.method]
      try { reply(true, h ? h(f.params) : {}) } catch (e) { reply(false, { message: e.message, details: { details: { code: e.code || '' } } }) }
    })
  })
  return gw
}
