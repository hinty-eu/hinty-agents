import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildHotwords, readVocab, readWordList, segmentations } from '../src/stt/hotwords.js'

const vocab = new Set(['▁com', 'mit', '▁commit', '▁co', 'mm', 'it', '▁pull', '▁request', '▁re', 'quest', '▁Commit', '▁Pull', '▁Request'])

test('segmentations: fewest tokens first, only vocabulary pieces, none for unknown words', () => {
  const s = segmentations('commit', vocab)
  assert.deepEqual(s[0], ['▁commit'])
  assert.ok(s.some((x) => x.join(' ') === '▁com mit'))
  assert.ok(s.every((x) => x.every((t) => vocab.has(t))))
  assert.deepEqual(segmentations('zzz', vocab), [])
})

test('buildHotwords: one "tokens :score" line per variant, phrases join the words, unknown words are skipped', () => {
  const text = buildHotwords([{ word: 'commit', score: null }, { word: 'pull request', score: 3 }, { word: 'zzz', score: null }], vocab, 2)
  const lines = text.split('\n')
  assert.ok(lines.includes('▁commit :2'))
  assert.ok(lines.includes('▁com mit :2'))
  assert.ok(lines.includes('▁Commit :2'), 'capitalised form (start of a sentence)')
  assert.ok(lines.includes('▁pull ▁request :3'))
  assert.ok(lines.every((l) => / :-?\d+(\.\d+)?$/.test(l)))
  assert.ok(!text.includes('zzz'))
})

test('readWordList: comments, blank lines, per-word scores; a missing file is an empty list', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hw-')), 'w.txt')
  fs.writeFileSync(f, '# comment\n\ncommit\nrebase :3.5  # trailing\npull request\n')
  assert.deepEqual(readWordList(f), [{ word: 'commit', score: null }, { word: 'rebase', score: 3.5 }, { word: 'pull request', score: null }])
  assert.deepEqual(readWordList(f + '.none'), [])
})

test('readVocab: "token id" lines', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hw-')), 'tokens.txt')
  fs.writeFileSync(f, '<unk> 0\n▁com 1\nmit 2\n')
  assert.deepEqual([...readVocab(f)], ['<unk>', '▁com', 'mit'])
})
