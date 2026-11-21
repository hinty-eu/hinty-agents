// @ts-check
// One spoken instruction at a time (E3): relay events audio_start / audio / audio_end in, `stt` events out.
// Contract: hintyall/docs/podpowiedzi/kontrakt-v2.md, section "Glos z okularow do agenta (E3 ...)".
//  - The PCM (s16le mono 16 kHz) is fed straight to the VAD; only the VAD's own buffer holds it, and it is dropped
//    when the utterance ends. Nothing is written to disk and nothing is logged except numbers.
//  - Every finished stretch of speech is recognized in the background: `stt {fin:false}` carries the whole text so far.
//  - N5: with "away from desk" off nothing is read, kept or recognized; the screen gets `stt {err:'away_off'}` only.
import { SID_RE } from '../sessions.js'

export const UID_RE = /^[A-Za-z0-9_-]{8,32}$/
/** 35 s of s16le mono 16 kHz */
export const MAX_BYTES = 35 * 32000
export const MAX_TEXT = 8000
/** safety net: the final text must come this long after the end of the speech */
export const FINISH_TIMEOUT_MS = 60 * 1000
/** an utterance with no frame for this long, or older than MAX_AGE_MS, is finished by itself (a lost or never sent
 *  `audio_end` must not block every next utterance with `busy`; security review point 9) */
export const IDLE_MS = 20 * 1000
export const MAX_AGE_MS = 60 * 1000
/** larger frames are dropped (the contract allows up to 32000 bytes per frame from the screen) */
export const MAX_FRAME = 64000
const REJECTED_KEEP = 64

/** @typedef {{ createVad: () => { accept: (s: Float32Array) => Float32Array[], flush: () => Float32Array[] },
 *   recognize: (s: Float32Array) => Promise<string>, load: () => Promise<any> }} Engine */
/** @typedef {{ uid: string, sid: string, bytes: number, vad: ReturnType<Engine['createVad']> | null, parts: string[],
 *   chain: Promise<void>, dead: boolean, ending: boolean, lastSent: string, failed: boolean, startedAt: number, lastAt: number,
 *   watch: any }} Utt */

/** @param {Buffer | Uint8Array} pcm @returns {Float32Array} */
export function pcmToFloat(pcm) {
  const n = pcm.length >> 1
  const out = new Float32Array(n)
  const dv = new DataView(pcm.buffer, pcm.byteOffset, n * 2)
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768
  return out
}

export class Utterances {
  /**
   * @param {{ engine: Engine, send: (ev: string, payload: unknown) => boolean, awayOn: () => boolean,
   *   hasSession: (sid: string) => boolean, ready: () => boolean, log?: (m: string, f?: Record<string, any>) => void,
   *   now?: () => number, finishTimeoutMs?: number, idleMs?: number, maxAgeMs?: number }} o
   */
  constructor(o) {
    this.engine = o.engine
    this.send = o.send
    this.awayOn = o.awayOn
    this.hasSession = o.hasSession
    this.ready = o.ready
    this.log = o.log || (() => {})
    this.now = o.now || Date.now
    this.finishTimeoutMs = o.finishTimeoutMs ?? FINISH_TIMEOUT_MS
    this.idleMs = o.idleMs ?? IDLE_MS
    this.maxAgeMs = o.maxAgeMs ?? MAX_AGE_MS
    /** @type {Utt | null} */
    this.active = null
    /** @type {Set<string>} uids we refused or ended: their late frames are dropped without an answer */
    this.closed = new Set()
  }

  /** @param {string} uid */
  remember(uid) {
    this.closed.add(uid)
    if (this.closed.size > REJECTED_KEEP) this.closed.delete(/** @type {string} */ (this.closed.values().next().value))
  }

  /** @param {string} uid @param {string} err */
  refuse(uid, err) {
    this.remember(uid)
    this.log('stt_refused', { err })
    this.send('stt', { uid, text: '', fin: true, err })
  }

  /** @param {unknown} p {uid, sid} */
  onStart(p) {
    if (!p || typeof p !== 'object') return
    const { uid, sid } = /** @type {any} */ (p)
    if (typeof uid !== 'string' || !UID_RE.test(uid) || typeof sid !== 'string' || !SID_RE.test(sid)) return
    if (this.active && this.active.uid === uid) return
    // checked before anything else is looked at (N5): nothing is read, kept or recognized
    if (!this.awayOn()) return this.refuse(uid, 'away_off')
    if (!this.ready()) return this.refuse(uid, 'no_stt')
    if (!this.hasSession(sid)) return this.refuse(uid, 'no_session')
    if (this.active) return this.refuse(uid, 'busy')
    /** @type {Utt} */
    const u = { uid, sid, bytes: 0, vad: null, parts: [], chain: Promise.resolve(), dead: false, ending: false, lastSent: '', failed: false, startedAt: this.now(), lastAt: this.now(), watch: null }
    try {
      u.vad = this.engine.createVad()
    } catch (e) {
      this.log('stt_vad_failed', { err: /** @type {Error} */ (e)?.name || 'error' })
      return this.refuse(uid, 'failed')
    }
    this.active = u
    this.watchdog(u)
    // load the model now, so it is ready before the person stops talking
    this.engine.load().catch((e) => { u.failed = true; this.log('stt_load_failed', { err: /** @type {Error} */ (e)?.name || 'error' }) })
    this.log('stt_start', { uid })
  }

  /** @param {unknown} p {uid, seq, pcm} */
  onAudio(p) {
    if (!p || typeof p !== 'object') return
    const { uid, pcm } = /** @type {any} */ (p)
    const u = this.active
    if (!u || u.uid !== uid || u.dead || u.ending) return
    if (!this.awayOn()) return this.abort(u, 'away_off')
    if (!(pcm instanceof Uint8Array) || pcm.length < 2 || pcm.length > MAX_FRAME) return
    u.lastAt = this.now()
    u.bytes += pcm.length & ~1
    if (u.bytes > MAX_BYTES) return this.abort(u, 'too_long')
    try {
      for (const seg of /** @type {NonNullable<Utt['vad']>} */ (u.vad).accept(pcmToFloat(pcm.length & 1 ? pcm.subarray(0, pcm.length - 1) : pcm))) this.queue(u, seg, true)
    } catch (e) {
      this.log('stt_vad_error', { err: /** @type {Error} */ (e)?.name || 'error' })
      this.abort(u, 'failed')
    }
  }

  /** @param {unknown} p {uid, why} */
  onEnd(p) {
    if (!p || typeof p !== 'object') return
    const { uid, why } = /** @type {any} */ (p)
    const u = this.active
    if (!u || u.uid !== uid) return
    if (why === 'end' || why === 'limit') {
      if (!this.awayOn()) return this.abort(u, 'away_off')
      void this.finish(u)
    } else if (why === 'cancel' || why === 'gone') {
      this.drop(u)
    }
  }

  /** Away mode turned off (or the service stops): the running utterance is thrown away, the screen is told. @param {string} err */
  abortAll(err = 'away_off') {
    if (this.active) this.abort(this.active, err)
  }

  /** Link lost / service stopping: nobody to tell. */
  dropActive() {
    if (this.active) this.drop(this.active)
  }

  /** @param {Utt} u @param {string} err */
  abort(u, err) {
    this.drop(u)
    this.send('stt', { uid: u.uid, text: '', fin: true, err })
  }

  /**
   * Ends the utterance by itself when its frames stop for IDLE_MS or it is older than MAX_AGE_MS (what was heard is
   * recognized, like `audio_end limit`).
   * @param {Utt} u
   */
  watchdog(u) {
    const check = () => {
      u.watch = null
      if (u.dead || u.ending || this.active !== u) return
      const now = this.now()
      if (now - u.lastAt >= this.idleMs || now - u.startedAt >= this.maxAgeMs) {
        this.log('stt_idle_end', { uid: u.uid })
        if (!this.awayOn()) return this.abort(u, 'away_off')
        void this.finish(u)
        return
      }
      u.watch = setTimeout(check, Math.min(1000, this.idleMs))
      u.watch.unref?.()
    }
    u.watch = setTimeout(check, Math.min(1000, this.idleMs))
    u.watch.unref?.()
  }

  /** @param {Utt} u */
  drop(u) {
    if (u.watch) { clearTimeout(u.watch); u.watch = null }
    u.dead = true
    u.vad = null
    u.parts = []
    this.remember(u.uid)
    if (this.active === u) this.active = null
    this.log('stt_drop', { uid: u.uid })
  }

  /** @param {Utt} u @param {Float32Array} seg @param {boolean} partial */
  queue(u, seg, partial) {
    u.chain = u.chain.then(async () => {
      if (u.dead || u.failed) return
      try {
        const t = await this.engine.recognize(seg)
        if (u.dead) return
        if (t) u.parts.push(t)
        const text = this.text(u)
        if (partial && !u.ending && text && text !== u.lastSent) { u.lastSent = text; this.send('stt', { uid: u.uid, text, fin: false }) }
      } catch (e) {
        u.failed = true
        this.log('stt_error', { err: /** @type {Error} */ (e)?.name || 'error' })
      }
    })
  }

  /** @param {Utt} u */
  text(u) {
    const t = u.parts.join(' ').replace(/\s+/g, ' ').trim()
    return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT - 1) + '…' : t
  }

  /** @param {Utt} u */
  async finish(u) {
    u.ending = true
    const t0 = this.now()
    let timer
    const timeout = new Promise((r) => { timer = setTimeout(() => r('timeout'), this.finishTimeoutMs); timer.unref?.() })
    const work = (async () => {
      await u.chain
      if (u.dead) return 'dead'
      for (const seg of /** @type {NonNullable<Utt['vad']>} */ (u.vad).flush()) this.queue(u, seg, false)
      await u.chain
      return 'done'
    })()
    let r
    try { r = await Promise.race([work, timeout]) } catch { r = 'error' }
    clearTimeout(timer)
    if (u.dead) return
    const text = this.text(u)
    const err = r !== 'done' || u.failed ? 'failed' : undefined
    this.log('stt_fin', { uid: u.uid, ms: this.now() - t0, chars: text.length, err })
    this.drop(u)
    this.send('stt', err ? { uid: u.uid, text: '', fin: true, err } : { uid: u.uid, text, fin: true })
  }
}
