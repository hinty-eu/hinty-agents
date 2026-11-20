// The mod's own HMAC (built on crypto.subtle.digest, the only crypto the mod environment has) must match the service's
// proof, or the mod would ignore every answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { hmacSha256Hex, nonce } from '../claude-plugin/hooks/hmac.mjs'
import { proof } from '../src/crypto.js'

test('mod HMAC = node:crypto HMAC (short, 64-byte and long keys, unicode body)', async () => {
  for (const secret of ['k'.repeat(43), 'x'.repeat(64), 'y'.repeat(100), 'Zx9-_aB']) {
    for (const msg of ['', 'n1\n{"away":true,"cmds":[]}', 'n\n{"text":"👓 zażółć gęślą jaźń"}']) {
      assert.equal(await hmacSha256Hex(secret, msg), createHmac('sha256', secret).update(msg, 'utf8').digest('hex'))
    }
  }
  assert.equal(await hmacSha256Hex('s', 'abc\nbody'), proof('s', 'abc', 'body'))
})

test('mod nonce: 32 hex characters, different each time', () => {
  const a = nonce()
  assert.match(a, /^[0-9a-f]{32}$/)
  assert.notEqual(a, nonce())
})
