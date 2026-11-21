// A fake OpenClaw Gateway for tests: the WebSocket framing, the challenge / connect handshake with a real check of the
// Ed25519 signature, protocol negotiation (`protocol mismatch` + expectedProtocol), a device token issued per device
// (with the scopes asked for at pairing; a later connect gets at most those), and a hook for the test to push events and
// see every request the bridge sends, with the scopes of the connection it came over.
import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'
import { signPayload } from '../../src/adapters/openclaw-client.js'

const b64uToBuf = (s) => Buffer.from(s.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * @param {{ protocol?: number, sharedToken?: string, deviceToken?: string, rejectDeviceToken?: boolean,
 *   extraScopes?: string[] }} [o] extraScopes: granted at pairing on top of what was asked (a Gateway that gives more)
 */
export async function startGateway({ protocol = 3, sharedToken = 'shared-token-AAAA', deviceToken = 'device-token-SECRET', rejectDeviceToken = false, extraScopes = [] } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((r) => wss.once('listening', r))
  const port = wss.address().port
  /** @type {Set<any>} */
  const sockets = new Set()
  /** token -> { deviceId, scopes } */
  const issued = new Map()
  const gw = {
    port, url: `ws://127.0.0.1:${port}`, sockets, requests: [], connects: [], tokensSeen: [], issued,
    /** how a request is answered: method -> (params) => payload | throws {message, code} */
    handlers: {},
    /** @type {((n: number, params: any) => 'close' | 'silent' | 'notoken' | undefined) | null} */
    onConnect: null,
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
        // a test may make the n-th connect fail: 'close' (socket dropped), 'silent' (never answered), 'notoken'
        const act = gw.onConnect ? gw.onConnect(gw.connects.length, p) : undefined
        if (act === 'close') return ws.terminate()
        if (act === 'silent') return
        if (p.minProtocol !== protocol || p.maxProtocol !== protocol) {
          return reply(false, { message: 'protocol mismatch', details: { expectedProtocol: protocol } })
        }
        // check the signature the way the Gateway does
        const raw32 = b64uToBuf(p.device.publicKey)
        const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw32]), format: 'der', type: 'spki' })
        const text = signPayload({ deviceId: p.device.id, clientId: p.client.id, mode: p.client.mode, role: p.role, scopes: p.scopes, signedAt: p.device.signedAt, token: (p.auth && p.auth.token) || '', nonce, platform: p.client.platform })
        const sigOk = crypto.verify(null, Buffer.from(text, 'utf8'), key, b64uToBuf(p.device.signature))
        const idOk = crypto.createHash('sha256').update(raw32).digest('hex') === p.device.id
        if (!sigOk || !idOk || p.device.nonce !== nonce) return reply(false, { message: 'device signature invalid', details: { details: { code: 'DEVICE_AUTH_INVALID' } } })
        const tok = p.auth && p.auth.token
        let scopes
        let token
        if (tok === sharedToken) {
          // the first loopback connection of a device pairs it: a token of its own, with the scopes it asked for
          scopes = [...new Set([...p.scopes, ...extraScopes])]
          token = `${deviceToken}-${p.device.id.slice(0, 8)}`
          issued.set(token, { deviceId: p.device.id, scopes })
        } else {
          const t = !rejectDeviceToken && issued.get(tok)
          if (!t || t.deviceId !== p.device.id) return reply(false, { message: 'unauthorized', details: { details: { code: 'AUTH_TOKEN_MISMATCH', canRetryWithDeviceToken: false } } })
          scopes = p.scopes.filter((s) => t.scopes.includes(s))
          token = tok
        }
        ws.authed = true
        ws.scopes = scopes
        ws.deviceId = p.device.id
        return reply(true, { type: 'hello-ok', protocol, server: { version: 'fake-1', connId: 'c1' }, auth: act === 'notoken' ? { role: 'operator', scopes } : { deviceToken: token, role: 'operator', scopes, issuedAtMs: Date.now() } })
      }
      if (!ws.authed) return reply(false, { message: 'not connected' })
      gw.requests.push({ method: f.method, params: f.params, scopes: ws.scopes, deviceId: ws.deviceId })
      const h = gw.handlers[f.method]
      try { reply(true, h ? h(f.params) : {}) } catch (e) { reply(false, { message: e.message, details: { details: { code: e.code || '' } } }) }
    })
  })
  return gw
}
