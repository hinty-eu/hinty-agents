// @ts-check
// Speech recognition engine on sherpa-onnx (E3). The module is loaded lazily from ~/.hinty-agents/voice/, the model
// when an utterance starts (so it is ready before the person stops talking) and released after 10 idle minutes.
// Everything runs on this computer; nothing here touches the network.
import os from 'node:os'
import { loadSherpa, modelState, readVoiceConfig } from './install.js'
import { DEFAULT_MODEL, MODELS, VAD_MODEL, modelPath } from './models.js'

export const IDLE_RELEASE_MS = 10 * 60 * 1000
export const SAMPLE_RATE = 16000

export const threads = () => Math.max(1, Math.min(4, Math.floor((os.cpus().length || 2) / 2)))

/** @param {string} id @param {number} numThreads */
export function recognizerConfig(id, numThreads = threads()) {
  const m = MODELS[id]
  const p = (/** @type {string} */ n) => modelPath(id, n)
  const names = m.files.map((f) => f.name)
  const find = (/** @type {RegExp} */ re) => p(/** @type {string} */ (names.find((n) => re.test(n))))
  if (m.kind === 'transducer') {
    return {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: find(/encoder/), decoder: find(/decoder/), joiner: find(/joiner/) },
        tokens: find(/tokens/), numThreads, provider: 'cpu', debug: 0, modelType: 'nemo_transducer',
      },
    }
  }
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      whisper: { encoder: find(/encoder/), decoder: find(/decoder/), language: '', task: 'transcribe', tailPaddings: -1 },
      tokens: find(/tokens/), numThreads, provider: 'cpu', debug: 0,
    },
  }
}

/** VAD settings: a pause of 0.45 s closes a segment (the segment is then recognized in the background). */
export function vadConfig() {
  return {
    sileroVad: { model: modelPath(VAD_MODEL, 'silero_vad.onnx'), threshold: 0.4, minSilenceDuration: 0.45, minSpeechDuration: 0.12, windowSize: 512, maxSpeechDuration: 28 },
    sampleRate: SAMPLE_RATE, numThreads: 1, provider: 'cpu', debug: 0,
  }
}

export class SherpaEngine {
  /** @param {{ model?: string, log?: (m: string, f?: Record<string, any>) => void, idleMs?: number }} [o] */
  constructor(o = {}) {
    this.log = o.log || (() => {})
    this.idleMs = o.idleMs ?? IDLE_RELEASE_MS
    this.modelId = o.model || null
    /** @type {any} */ this.sherpa = null
    /** @type {any} */ this.rec = null
    /** @type {Promise<any> | null} */ this.loading = null
    /** @type {any} */ this.idleTimer = null
    this.busy = 0
    /** serial queue of decodes: one decode at a time uses all threads */
    this.chain = Promise.resolve()
  }

  get modelName() { return this.modelId || readVoiceConfig()?.model || DEFAULT_MODEL }

  /** Model files and the VAD are on disk (cheap; no loading). */
  available() {
    const id = this.modelName
    return modelState(id).ok && modelState(VAD_MODEL).ok
  }

  /** Start loading (no-op when loaded or loading). @returns {Promise<any>} */
  load() {
    this.touch()
    if (this.rec) return Promise.resolve(this.rec)
    if (this.loading) return this.loading
    const id = this.modelName
    this.loading = (async () => {
      this.sherpa = this.sherpa || loadSherpa()
      const t0 = Date.now()
      const rec = await this.sherpa.OfflineRecognizer.createAsync(recognizerConfig(id))
      this.rec = rec
      this.log('stt_loaded', { model: id, ms: Date.now() - t0 })
      return rec
    })().finally(() => { this.loading = null })
    return this.loading
  }

  touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.releaseIfIdle(), this.idleMs)
    this.idleTimer.unref?.()
  }

  releaseIfIdle() {
    if (this.busy > 0 || this.loading) { this.touch(); return }
    this.release()
  }

  release() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.rec) this.log('stt_released')
    this.rec = null
  }

  /**
   * The VAD cuts a segment exactly where it hears speech, which clips soft first consonants ("Fix" -> "ix"). So the
   * wrapper keeps the utterance's samples (in memory only, 35 s at most, freed with the VAD) and returns each
   * segment with 0.3 s before and 0.2 s after it, never overlapping the previous one.
   * @returns {{ accept: (s: Float32Array) => Float32Array[], flush: () => Float32Array[] }}
   */
  createVad() {
    const sherpa = this.sherpa || (this.sherpa = loadSherpa())
    const vad = new sherpa.Vad(vadConfig(), 40)
    /** @type {Float32Array[]} */
    let chunks = []
    let total = 0
    let prevEnd = 0
    const PRE = Math.round(0.3 * SAMPLE_RATE)
    const POST = Math.round(0.2 * SAMPLE_RATE)
    const slice = (/** @type {number} */ from, /** @type {number} */ to) => {
      const out = new Float32Array(Math.max(0, to - from))
      let pos = 0
      for (const c of chunks) {
        const a = Math.max(from, pos), e = Math.min(to, pos + c.length)
        if (e > a) out.set(c.subarray(a - pos, e - pos), a - from)
        pos += c.length
      }
      return out
    }
    const drain = () => {
      /** @type {Float32Array[]} */
      const out = []
      while (!vad.isEmpty()) {
        const seg = vad.front(false)
        const start = Number(seg.start) || 0
        const end = start + seg.samples.length
        const from = Math.max(prevEnd, start - PRE)
        const to = Math.min(total, end + POST)
        out.push(slice(from, to))
        prevEnd = to
        vad.pop()
      }
      return out
    }
    return {
      accept: (s) => { chunks.push(Float32Array.from(s)); total += s.length; vad.acceptWaveform(s); return drain() },
      flush: () => { vad.flush(); const r = drain(); chunks = []; return r },
    }
  }

  /** @param {Float32Array} samples @returns {Promise<string>} */
  recognize(samples) {
    const run = async () => {
      const rec = await this.load()
      this.busy++
      try {
        const stream = rec.createStream()
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
        await rec.decodeAsync(stream)
        const r = rec.getResult(stream)
        return String(r && r.text || '').trim()
      } finally { this.busy--; this.touch() }
    }
    const p = this.chain.then(run, run)
    this.chain = p.catch(() => {})
    return p
  }
}

/** Used by `voice install`: load the model once and decode a second of silence, to prove it works. @param {string} id */
export async function trialLoad(id) {
  const eng = new SherpaEngine({ model: id })
  try {
    await eng.load()
    await eng.recognize(new Float32Array(SAMPLE_RATE))
    const v = eng.createVad()
    v.accept(new Float32Array(SAMPLE_RATE / 2))
    v.flush()
  } finally { eng.release() }
}
