// @ts-check
// Connection to the Hinty relay (`/agents-link`, Socket.IO, token of this bridge). Reconnects with a growing pause.
// Contract: hintyall/docs/podpowiedzi/kontrakt-v2.md, section "Łącze agentów".
import { EventEmitter } from 'node:events'
import { io as ioDefault } from 'socket.io-client'

const SERVER_EVENTS = ['ready', 'decide', 'say', 'away', 'want', 'perm_refused', 'unpaired', 'denied', 'audio_start', 'audio', 'audio_end']

export class Relay extends EventEmitter {
  /**
   * @param {{ api: string, token: string, io?: typeof ioDefault, log?: (m: string, f?: Record<string, any>) => void,
   *   minDelayMs?: number, maxDelayMs?: number }} o
   */
  constructor(o) {
    super()
    this.api = o.api.replace(/\/+$/, '')
    this.token = o.token
    this.io = o.io || ioDefault
    this.log = o.log || (() => {})
    this.minDelayMs = o.minDelayMs ?? 2000
    this.maxDelayMs = o.maxDelayMs ?? 5 * 60 * 1000
    this.delay = this.minDelayMs
    /** @type {import('socket.io-client').Socket | null} */
    this.socket = null
    this.stopped = false
    /** @type {any} */
    this.retryTimer = null
  }

  get connected() { return !!this.socket && this.socket.connected }

  start() {
    this.stopped = false
    this.open()
  }

  open() {
    if (this.stopped) return
    if (this.socket) { this.socket.removeAllListeners(); this.socket.close() }
    const s = this.io(`${this.api}/agents-link`, {
      transports: ['websocket'],
      auth: { bridgeToken: this.token },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 60000,
      randomizationFactor: 0.5,
      timeout: 15000,
      forceNew: true,
    })
    this.socket = s
    s.on('connect', () => {
      this.delay = this.minDelayMs
      this.log('relay_up')
      this.emit('connect')
    })
    s.on('disconnect', (reason) => {
      this.log('relay_down', { reason })
      this.emit('relay', 'disconnect', { reason })
      // the server closed us on purpose (replaced, rate limit, revoked): Socket.IO does not retry by itself
      if (reason === 'io server disconnect') this.retry()
    })
    s.on('connect_error', (err) => {
      const msg = String(err && err.message || 'error')
      this.log('relay_refused', { reason: msg.slice(0, 40) })
      if (msg === 'invalid_token') {
        this.emit('relay', 'invalid_token', { reason: msg })
        this.stop()
        return
      }
      this.emit('relay', 'connect_error', { reason: msg.slice(0, 60) })
      // refused by the server's middleware (off, not_allowed, unauthorized...): no automatic retry, so retry slowly
      if (!s.active) this.retry()
    })
    for (const ev of SERVER_EVENTS) {
      s.on(ev, (payload) => {
        if (ev === 'denied' && payload && payload.reason === 'replaced') this.delay = this.maxDelayMs
        this.emit('relay', ev, payload)
      })
    }
  }

  retry() {
    if (this.stopped || this.retryTimer) return
    const wait = this.delay
    this.delay = Math.min(this.delay * 2, this.maxDelayMs)
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.open() }, wait)
    this.retryTimer.unref?.()
  }

  /** @param {string} ev @param {unknown} [payload] */
  send(ev, payload) {
    if (!this.connected || !this.socket) return false
    if (payload === undefined) this.socket.emit(ev)
    else this.socket.emit(ev, payload)
    return true
  }

  stop() {
    this.stopped = true
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    if (this.socket) { this.socket.removeAllListeners(); this.socket.close(); this.socket = null }
  }
}
