// Security review points 4, 9, 10, 11, 12: pairing shows the account and accepts only well-formed answers; text from
// the server is cleaned before it reaches a terminal or the log; npm gets a folder with a space as one argument; an
// utterance without `audio_end` does not block the next one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pair, cleanAccount } from '../src/pair.js'
import { createLog } from '../src/log.js'
import { Service } from '../src/service.js'
import { Utterances } from '../src/stt/utterance.js'
import { npmLaunch, runSync } from '../src/exec.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** a stand-in socket.io client: the test plays the server */
function fakeIo() {
  const sock = new EventEmitter()
  sock.io = new EventEmitter()
  sock.out = []
  const on = sock.on.bind(sock)
  sock.on = (ev, fn) => on(ev, fn)
  sock.emit2 = sock.emit.bind(sock)
  sock.emit = (ev, p) => { sock.out.push([ev, p]); return true }
  sock.close = () => {}
  sock.connect = () => {}
  sock.server = (ev, p) => sock.emit2(ev, p)
  return { io: () => sock, sock }
}

test('pairing: paired carries the masked account (cleaned); malformed codes and answers are refused', async () => {
  const { io, sock } = fakeIo()
  const codes = []
  const p = pair({ api: 'http://x', io, onCode: (c) => codes.push(c) })
  sock.server('connect')
  assert.equal(sock.out[0][0], 'pair_start')
  sock.server('pair_code', { code: '\x1b]0;evil\x07', expiresIn: 600 })
  sock.server('pair_code', { code: 'ACD4FG', expiresIn: 600 })
  assert.deepEqual(codes, ['ACD4FG'], 'only a code of the server alphabet is shown')
  sock.server('paired', { token: 'T'.repeat(32), bridgeId: 'a'.repeat(24), account: 'a***@g***.com' })
  assert.deepEqual(await p, { token: 'T'.repeat(32), bridgeId: 'a'.repeat(24), account: 'a***@g***.com' })

  const f2 = fakeIo()
  const p2 = pair({ api: 'http://x', io: f2.io, onCode: () => {} })
  f2.sock.server('connect')
  f2.sock.server('paired', { token: 'T'.repeat(32), bridgeId: 'b'.repeat(24) })
  assert.equal((await p2).account, null, 'no account field: the CLI asks the person to check the panel')

  const f3 = fakeIo()
  const p3 = pair({ api: 'http://x', io: f3.io, onCode: () => {} })
  f3.sock.server('connect')
  f3.sock.server('paired', { token: 'T"; rm -rf /', bridgeId: 'x' })
  await assert.rejects(p3, /bad_pairing_answer/)

  assert.equal(cleanAccount('a***@g***.com\x1b[2J'), 'a***@g***.com')
  assert.equal(cleanAccount('\u202ea***@g***.com'), 'a***@g***.com')
  assert.equal(cleanAccount('two words@x'), null)
  assert.equal(cleanAccount(5), null)
})

test('the log keeps one event per line whatever a value holds', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hinty-log-')), 'd.log')
  const log = createLog(file)
  log('decide_refused', { rid: 'abc\n2026-11-21T00:00:00.000Z perm_end rid=x why=decided d=allow' })
  log('relay_refused', { reason: 'x\r\u2028y\u202ez' })
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.ok(!/[\r\u2028\u202e]/.test(lines[1]))
})

test('a refusal reason from the server reaches status as one short clean line', () => {
  const svc = new Service({ relay: { connected: false, emit() {} } })
  svc.onRelay('denied', { reason: '\x1b[2J\x1b[31mYOU ARE HACKED\x1b[0m\n'.repeat(20) })
  const e = svc.status().relay.lastError
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(e), JSON.stringify(e))
  assert.ok(Array.from(e).length <= 60)
  svc.stop()
})

test('npm without a shell: a folder with a space and an & reaches npm as one argument', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hinty-npm-')), 'Jan Kowalski & co')
  fs.mkdirSync(dir)
  const npm = npmLaunch()
  assert.ok(npm, 'npm found')
  const r = runSync(npm, ['prefix', '--prefix', dir], { encoding: 'utf8', timeout: 60000, cwd: dir })
  assert.equal(r.status, 0, String(r.stderr))
  assert.equal(path.resolve(String(r.stdout).trim()), path.resolve(dir))
})

test('an utterance whose audio_end never comes ends by itself; a frame over 64 KB is dropped', async () => {
  const sent = []
  let fed = 0
  const engine = {
    createVad: () => ({ accept: (s) => { fed += s.length; return [] }, flush: () => [new Float32Array(10)] }),
    recognize: async () => 'hello',
    load: async () => {},
  }
  const u = new Utterances({ engine, send: (ev, p) => { sent.push([ev, p]); return true }, awayOn: () => true, hasSession: () => true, ready: () => true, idleMs: 80, maxAgeMs: 5000 })
  u.onStart({ uid: 'utt-0001', sid: 's1' })
  u.onAudio({ uid: 'utt-0001', seq: 0, pcm: new Uint8Array(3200) })
  u.onAudio({ uid: 'utt-0001', seq: 1, pcm: new Uint8Array(70000) })
  assert.equal(fed, 1600, 'only the normal frame reached the VAD')
  await sleep(1400)
  assert.equal(u.active, null, 'ended without audio_end')
  assert.deepEqual(sent.at(-1), ['stt', { uid: 'utt-0001', text: 'hello', fin: true }])
  u.onStart({ uid: 'utt-0002', sid: 's1' })
  assert.equal(u.active && u.active.uid, 'utt-0002', 'the next utterance is not "busy"')
  u.dropActive()
})
