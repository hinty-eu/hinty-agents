// @ts-check
// Contextual biasing for the Parakeet transducer (E3): a list of developer words ("commit", "rebase", "pull request",
// "package.json" ...) is turned into token sequences of the model's own vocabulary and handed to every stream, so the
// recognizer prefers these words when the sound is close. The built-in list is src/stt/hotwords.txt; a person adds
// their own words, one per line, in ~/.hinty-agents/hotwords.txt (a line "word :2.5" sets a score for that word).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { homeDir } from '../store.js'

export const DEFAULT_SCORE = 2.0
const MAX_VARIANTS = 4
const BUILTIN = fileURLToPath(new URL('./hotwords.txt', import.meta.url))

/** @param {string} file @returns {Array<{ word: string, score: number | null }>} */
export function readWordList(file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  /** @type {Array<{ word: string, score: number | null }>} */
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^(.*?)\s*:\s*(-?\d+(?:\.\d+)?)$/.exec(line)
    out.push(m ? { word: m[1].trim(), score: Number(m[2]) } : { word: line, score: null })
  }
  return out
}

/** All words: built-in plus the person's own. */
export const allWords = () => [...readWordList(BUILTIN), ...readWordList(path.join(homeDir(), 'hotwords.txt'))]

/** @param {string} tokensFile @returns {Set<string>} */
export function readVocab(tokensFile) {
  const set = new Set()
  for (const l of fs.readFileSync(tokensFile, 'utf8').split(/\r?\n/)) {
    const m = /^(.*) \d+$/.exec(l)
    if (m && m[1]) set.add(m[1])
  }
  return set
}

/**
 * Segmentations of one word (with the leading "▁" of SentencePiece) into vocabulary tokens, fewest tokens first.
 * @param {string} word @param {Set<string>} vocab @param {number} [max]
 * @returns {string[][]}
 */
export function segmentations(word, vocab, max = MAX_VARIANTS) {
  const s = '▁' + word
  /** @type {string[][]} */
  const found = []
  const maxTokens = 7
  /** @param {number} i @param {string[]} acc */
  const go = (i, acc) => {
    if (acc.length > maxTokens || found.length > 200) return
    if (i === s.length) { found.push(acc.slice()); return }
    for (let n = s.length - i; n >= 1; n--) {
      const piece = s.slice(i, i + n)
      if (vocab.has(piece)) { acc.push(piece); go(i + n, acc); acc.pop() }
    }
  }
  go(0, [])
  found.sort((a, b) => a.length - b.length)
  return found.slice(0, max)
}

/**
 * The hotwords text for `createStream(hotwords)`: one line per variant, "tokens :score".
 * @param {Array<{ word: string, score: number | null }>} words @param {Set<string>} vocab @param {number} score
 */
export function buildHotwords(words, vocab, score = DEFAULT_SCORE) {
  /** @type {Set<string>} */
  const lines = new Set()
  for (const { word, score: own } of words) {
    const parts = word.split(/\s+/).filter(Boolean)
    if (!parts.length) continue
    const sc = own ?? score
    const caps = parts.map((p) => p[0].toUpperCase() + p.slice(1))
    for (const form of new Set([parts.join(' '), caps.join(' ')])) {
      const fp = form.split(' ')
      // every word of a phrase is segmented on its own (each starts with the "▁" marker); the best variant per word
      const perWord = fp.map((w) => segmentations(w, vocab, MAX_VARIANTS))
      if (perWord.some((v) => !v.length)) continue
      for (let k = 0; k < MAX_VARIANTS; k++) {
        const toks = perWord.flatMap((v) => v[Math.min(k, v.length - 1)])
        lines.add(`${toks.join(' ')} :${sc}`)
      }
    }
  }
  return [...lines].join('\n')
}
