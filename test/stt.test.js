// E3 at the service level, with a fake engine (no model, no sherpa): the utterance state machine, N5, busy, cancel,
// gone, limit, and the shape of every event against the contract (kontrakt-v2.md, "Glos z okularow do agenta").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Service } from '../src/service.js'
import { pcmToFloat, MAX_BYTES } from '../src/stt/utterance.js'
import { MODELS } from '../src/stt/models.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SID = '1281aaaa-0000-4000-8000-000000000001'
const UID = 'u1234567890'
const UID2 = 'u2234567890'

/** 200 ms frame of a constant s16le value (0 = silence) */
const frame = (v, ms = 200) => {
  const b = Buffer.alloc(16 * ms * 2)
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(v, i)
  return b
}

/** A fake VAD: a silent frame (all zeros) closes the speech collected so far; flush returns the rest. */
function fakeEngine(o = {}) {
  const e = {
    vads: 0, loads: 0, recognized: [],
    createVad() {
      e.vads++
      let n = 0
      let v = 0
      return {
        accept(s) {
          if (s[0] === 0) { const r = n ? [Float32Array.of(v)] : []; n = 0; return r }
          n++; v = s[0]; return []
        },
        flush() { const r = n ? [Float32Array.of(v)] : []; n = 0; return r },
      }
    },
    async load() { e.loads++ },
    async recognize(seg) {
      e.recognized.push(seg[0])
      if (o.delay) await sleep(o.delay)
      if (o.fail) throw new Error('boom')
      return 'w' + Math.round(seg[0] * 32768)
    },
  }
  return e
}

function setup({ away = true, ready = true, engine = fakeEngine(), session = true, ...rest } = {}) {
  const relay = { connected: true, sent: [], emit(ev, p) { this.sent.push([ev, p]) } }
  const svc = new Service({ relay, host: 'h', sessDebounceMs: 0, voice: { engine, ready: () => ready }, ...rest })
  if (session) svc.sessions.touch({ sid: SID, cwd: 'E:\\work\\proj' })
  if (away) svc.setAway(true, 'test')
  relay.sent.length = 0
  return { relay, svc, engine }
}
const stts = (relay) => relay.sent.filter(([e]) => e === 'stt').map(([, p]) => p)
const start = (svc, uid = UID, sid = SID) => svc.onRelay('audio_start', { uid, sid })
const audio = (svc, v, seq = 0, uid = UID) => svc.onRelay('audio', { uid, seq, pcm: frame(v) })
const end = (svc, why = 'end', uid = UID) => svc.onRelay('audio_end', { uid, why })

test('pcmToFloat: s16le little endian to [-1, 1)', () => {
  const b = Buffer.alloc(6)
  b.writeInt16LE(16384, 0); b.writeInt16LE(-32768, 2); b.writeInt16LE(0, 4)
  assert.deepEqual([...pcmToFloat(b)], [0.5, -1, 0])
  const view = pcmToFloat(Buffer.concat([Buffer.alloc(3), b]).subarray(3)) // odd byteOffset
  assert.equal(view.length, 3)
})

test('E3: partial after each stretch of speech (whole text so far), final after audio_end end', async () => {
  const { relay, svc, engine } = setup()
  start(svc)
  assert.equal(engine.loads, 1, 'the model starts loading at audio_start')
  audio(svc, 1000, 0); audio(svc, 1000, 1); audio(svc, 0, 2) // first stretch closed by silence
  await sleep(20)
  audio(svc, 2000, 3); audio(svc, 0, 4)
  await sleep(20)
  audio(svc, 3000, 5)
  end(svc, 'end')
  await sleep(30)
  assert.deepEqual(stts(relay), [
    { uid: UID, text: 'w1000', fin: false },
    { uid: UID, text: 'w1000 w2000', fin: false },
    { uid: UID, text: 'w1000 w2000 w3000', fin: true },
  ])
  assert.equal(svc.voice.active, null)
  svc.stop()
})

test('E3: the limit (audio_end limit) recognizes what is there', async () => {
  const { relay, svc } = setup()
  start(svc); audio(svc, 1500); end(svc, 'limit')
  await sleep(20)
  assert.deepEqual(stts(relay), [{ uid: UID, text: 'w1500', fin: true }])
  svc.stop()
})

test('E3: no speech at all = an empty final text, no error', async () => {
  const { relay, svc } = setup()
  start(svc); audio(svc, 0); end(svc, 'end')
  await sleep(20)
  assert.deepEqual(stts(relay), [{ uid: UID, text: '', fin: true }])
  svc.stop()
})

test('E3: cancel and gone throw the utterance away, no stt at all', async () => {
  for (const why of ['cancel', 'gone']) {
    const { relay, svc } = setup()
    start(svc); audio(svc, 1000); audio(svc, 0); end(svc, why)
    await sleep(20)
    assert.deepEqual(stts(relay), [], why)
    assert.equal(svc.voice.active, null)
    audio(svc, 1000, 5) // a late frame of the dead uid: ignored, no answer
    end(svc, 'end')
    await sleep(10)
    assert.deepEqual(stts(relay), [], why + ' (late frames)')
    // the slot is free again
    start(svc, UID2); audio(svc, 500, 0, UID2); end(svc, 'end', UID2)
    await sleep(20)
    assert.deepEqual(stts(relay), [{ uid: UID2, text: 'w500', fin: true }])
    svc.stop()
  }
})

test('E3: a result that arrives after cancel is not sent', async () => {
  const { relay, svc } = setup({ engine: fakeEngine({ delay: 40 }) })
  start(svc); audio(svc, 1000); audio(svc, 0)
  end(svc, 'cancel')
  await sleep(80)
  assert.deepEqual(stts(relay), [])
  svc.stop()
})

test('E3: a second utterance gets busy; the first one carries on', async () => {
  const { relay, svc } = setup()
  start(svc); audio(svc, 1000)
  start(svc, UID2)
  assert.deepEqual(stts(relay), [{ uid: UID2, text: '', fin: true, err: 'busy' }])
  audio(svc, 7, 0, UID2); end(svc, 'end', UID2) // frames of the refused uid: dropped quietly
  end(svc, 'end')
  await sleep(20)
  assert.deepEqual(stts(relay).slice(1), [{ uid: UID, text: 'w1000', fin: true }])
  svc.stop()
})

test('N5: away mode off = only stt {err:away_off}, nothing read, no engine call', async () => {
  const { relay, svc, engine } = setup({ away: false })
  start(svc)
  audio(svc, 1000); audio(svc, 0); end(svc, 'end')
  await sleep(20)
  assert.deepEqual(relay.sent, [['stt', { uid: UID, text: '', fin: true, err: 'away_off' }]], 'the only thing that left')
  assert.equal(engine.vads, 0)
  assert.equal(engine.loads, 0)
  assert.equal(engine.recognized.length, 0)
  svc.stop()
})

test('N5: away mode off does not reveal whether the session, the model or the slot exist', async () => {
  const { relay, svc } = setup({ away: false, ready: false, session: false })
  start(svc, UID, 'unknown-session')
  assert.deepEqual(stts(relay), [{ uid: UID, text: '', fin: true, err: 'away_off' }])
  svc.stop()
})

test('N5: away turned off in the middle = away_off at once, text never leaves, PCM dropped', async () => {
  const { relay, svc } = setup({ engine: fakeEngine({ delay: 30 }) })
  start(svc); audio(svc, 1000); audio(svc, 0)
  svc.setAway(false, 'test')
  await sleep(80)
  audio(svc, 2000, 5); end(svc, 'end')
  await sleep(20)
  assert.deepEqual(stts(relay), [{ uid: UID, text: '', fin: true, err: 'away_off' }])
  assert.equal(svc.voice.active, null)
  svc.stop()
})

test('N5: the gate lets an stt with text through only while away mode is on', () => {
  const { relay, svc } = setup({ away: false })
  assert.equal(svc.send('stt', { uid: UID, text: 'secret words', fin: false }), false)
  assert.equal(svc.send('stt', { uid: UID, text: 'secret words', fin: true, err: 'failed' }), false, 'text with an error is not an error-only event')
  assert.equal(svc.send('stt', { uid: UID, text: '', fin: true, err: 'away_off' }), true)
  assert.equal(relay.sent.length, 1)
  svc.stop()
})

test('E3 errors: no_stt (not installed) and no_session', async () => {
  const a = setup({ ready: false })
  start(a.svc)
  assert.deepEqual(stts(a.relay), [{ uid: UID, text: '', fin: true, err: 'no_stt' }])
  a.svc.stop()
  const b = setup({ session: false })
  start(b.svc)
  assert.deepEqual(stts(b.relay), [{ uid: UID, text: '', fin: true, err: 'no_session' }])
  b.svc.stop()
  const sent = []
  const c = new Service({ relay: { connected: true, emit: (ev, p) => sent.push([ev, p]) }, sessDebounceMs: 0 }) // no voice engine at all
  c.sessions.touch({ sid: SID, cwd: 'x' })
  c.setAway(true, 't')
  sent.length = 0
  start(c)
  assert.deepEqual(sent, [['stt', { uid: UID, text: '', fin: true, err: 'no_stt' }]])
  c.stop()
})

test('E3 errors: recognizer failure = failed, no text; over 35 s = too_long', async () => {
  const a = setup({ engine: fakeEngine({ fail: true }) })
  start(a.svc); audio(a.svc, 1000); end(a.svc, 'end')
  await sleep(30)
  assert.deepEqual(stts(a.relay), [{ uid: UID, text: '', fin: true, err: 'failed' }])
  a.svc.stop()
  const b = setup()
  start(b.svc)
  const big = Buffer.alloc(32000 * 10, 1)
  for (let i = 0; i < 4; i++) b.svc.onRelay('audio', { uid: UID, seq: i, pcm: big })
  assert.ok(4 * big.length > MAX_BYTES)
  assert.deepEqual(stts(b.relay), [{ uid: UID, text: '', fin: true, err: 'too_long' }])
  assert.equal(b.svc.voice.active, null)
  b.svc.stop()
})

test('E3: malformed input is ignored (no crash, no answer)', async () => {
  const { relay, svc } = setup()
  for (const p of [null, 'x', {}, { uid: 'short', sid: SID }, { uid: UID }, { uid: UID, sid: 'has space' }, { uid: 'a b c d e f g h', sid: SID }]) svc.onRelay('audio_start', p)
  svc.onRelay('audio', null); svc.onRelay('audio_end', null); svc.onRelay('audio', { uid: UID, pcm: 'text' })
  assert.deepEqual(stts(relay), [])
  start(svc)
  svc.onRelay('audio', { uid: UID, seq: 0, pcm: 'not a buffer' })
  svc.onRelay('audio', { uid: UID, seq: 1, pcm: Buffer.alloc(1) })
  svc.onRelay('audio_end', { uid: UID, why: 'weird' })
  assert.ok(svc.voice.active, 'an unknown "why" changes nothing')
  svc.stop()
})

test('E3: link lost drops the utterance silently', async () => {
  const { relay, svc } = setup()
  start(svc); audio(svc, 1000)
  svc.onRelay('disconnect', { reason: 'x' })
  assert.equal(svc.voice.active, null)
  await sleep(10)
  assert.deepEqual(stts(relay), [])
  svc.stop()
})

test('E3: hello carries stt:true only when the voice is ready; voiceChanged says hello again', () => {
  const { relay, svc } = setup({ ready: false })
  svc.hello()
  assert.deepEqual(relay.sent.at(-1)[1], { v: 1, host: 'h', agents: ['claude'], away: true })
  svc.voiceReady = () => true
  assert.deepEqual(svc.voiceChanged(), { ok: true, stt: true })
  assert.deepEqual(relay.sent.at(-1), ['hello', { v: 1, host: 'h', agents: ['claude'], away: true, stt: true }])
  svc.stop()
})

test('models: every file has a url, a size and a 64-hex sha256; the default is the Parakeet int8', () => {
  for (const m of Object.values(MODELS)) {
    for (const f of m.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/)
      assert.ok(f.size > 0 && f.url.startsWith('https://'))
    }
  }
  assert.deepEqual(MODELS['parakeet-v3'].files.map((f) => f.name), ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'])
})
