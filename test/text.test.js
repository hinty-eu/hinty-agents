import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseLabel, glassesLine, oneLine, permText, relayText } from '../src/text.js'
import { SessionTable } from '../src/sessions.js'

test('glasses line: text after the last 👓, cut to 60 characters', () => {
  assert.equal(glassesLine('Done.\n\n👓 Fixed login form, 3 files'), 'Fixed login form, 3 files')
  assert.equal(glassesLine('a\n👓 first\nmore\n**👓 second line here**'), 'second line here')
  const long = glassesLine(`x\n👓 ${'a'.repeat(100)}`)
  assert.equal(Array.from(long).length, 60)
  assert.ok(long.endsWith('…'))
})

test('glasses line fallback: first sentence, masked', () => {
  assert.equal(glassesLine('## Result\nI created the file. Then I ran tests.'), 'Result I created the file.')
  assert.ok(!glassesLine('Set password=hunter22 in .env. Done.').includes('hunter22'))
})

test('permission text: Bash command and description, masked, no control characters, <= 8000', () => {
  // permText returns {text, complete} since the security review (point 3); masked or cleaned = not complete
  const { text: t, complete } = permText('Bash', { command: 'curl -H "Authorization: Bearer abcdefgh12345"\x07 x', description: 'call api' })
  assert.ok(t.startsWith('curl -H "Authorization: Bearer ***"'))
  assert.ok(t.includes('# call api'))
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(t))
  assert.equal(complete, false)
  assert.ok(permText('Write', { file_path: 'a.txt', content: 'x'.repeat(20000) }).text.length <= 8000)
  assert.ok(relayText('😀'.repeat(5000)).length <= 8000)
  assert.deepEqual(permText('mcp__x__y', null), { text: 'null', complete: false })
})

test('oneLine: no newlines, cut by code points', () => {
  assert.equal(oneLine('a\nb\tc', 10), 'a b c')
  assert.equal(Array.from(oneLine('👓'.repeat(80), 60)).length, 60)
})

test('labels: folder name, -2 for a second live session in a folder with the same name', () => {
  assert.equal(baseLabel('E:\\projekty-old\\hintyall\\hintyApi'), 'hintyApi')
  assert.equal(baseLabel('/home/me/web/'), 'web')
  const t = new SessionTable()
  assert.equal(t.touch({ sid: 's1', cwd: 'C:\\a\\api' }).s.label, 'api')
  assert.equal(t.touch({ sid: 's2', cwd: 'D:\\b\\api' }).s.label, 'api-2')
  assert.equal(t.touch({ sid: 's3', cwd: '/x/api' }).s.label, 'api-3')
  assert.equal(t.touch({ sid: 's1', cwd: 'C:\\a\\api' }).s.label, 'api')
  t.remove('s1')
  assert.equal(t.touch({ sid: 's4', cwd: '/y/api' }).s.label, 'api')
})
