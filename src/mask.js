// @ts-check
// N8: hide obvious secrets before any text leaves the computer (permission text, status line, last answer).
// Best effort: it catches well-known token formats and `key=value` assignments, not every secret there is.
//
// Security review points 3 and 5:
//  - every pattern is anchored (a name starts where a name can start) and every repetition is bounded, so no input
//    makes a pattern backtrack for long (test: 1 MB of crafted text in well under 100 ms); callers also cut the
//    text BEFORE masking (text.js);
//  - a value that contains shell syntax ($( ` ; | & < > ${) is never turned into *** (it could be the part of the
//    command that runs): it stays visible and `flagged` is set, so the card counts as incomplete (perm.part);
//  - a private key header without its END marker hides only the key lines, never the rest of the text.
//  `maskInfo` says whether anything was hidden (`masked`) or left visible on purpose (`flagged`); either makes a
//  permission card incomplete.

const M = '***'
/** shell syntax that executes or redirects: a value with it is shown, never hidden */
const SHELL = /[`;|&<>\n]|\$\(|\$\{/

const KEYS = 'password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth'
// NAME=value, NAME: value, --name value for secret-looking names (quoted or bare value). The name starts at a name
// boundary (lookbehind) and every part has an upper bound.
const KV = new RegExp(
  `(?<![A-Za-z0-9_.-])(--?)?([A-Za-z0-9_.-]{0,40}?(?:${KEYS})[A-Za-z0-9_.-]{0,40})(["']?)([ \\t]{0,4}(?:=|:|[ \\t])[ \\t]{0,4})` +
  `("[^"\\n]{0,1000}"|'[^'\\n]{0,1000}'|[^\\s"',;&|)]{1,1000})`, 'gi')

/** @type {Array<[RegExp, string]>} token formats with a recognisable prefix (keep the prefix, hide the rest) */
const TOKENS = [
  // Authorization headers
  [/\b(Bearer|Basic|Token)([ \t]{1,8})[A-Za-z0-9._~+/=-]{8,}/g, `$1$2${M}`],
  [/\b(sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{12,}/g, `$1${M}`],
  [/\b((?:sk|rk|pk)_(?:live|test)_)[A-Za-z0-9]{8,}/g, `$1${M}`],
  [/\b(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{16,}/g, `$1${M}`],
  [/\b(glpat-)[A-Za-z0-9_-]{16,}/g, `$1${M}`],
  [/\b(xox[abposr]-)[A-Za-z0-9-]{8,}/g, `$1${M}`],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, `$1${M}`],
  [/\b(AIza)[0-9A-Za-z_-]{30,}/g, `$1${M}`],
  [/\b(npm_)[A-Za-z0-9]{30,}/g, `$1${M}`],
  [/\b(hf_)[A-Za-z0-9]{30,}/g, `$1${M}`],
  [/\b(rnd_)[A-Za-z0-9]{16,}/g, `$1${M}`],
  [/\b(whsec_)[A-Za-z0-9]{16,}/g, `$1${M}`],
  // JSON Web Tokens. The start is a lookbehind on the token alphabet, not `\b`: `\b` also matches after every `-`, and
  // `-eyJ` repeated made each start read to the end of the run again (security review 2, Z11: 32 000 chars = 0.77 s).
  // With the lookbehind a start is only possible after a character that cannot be part of the run (or after ONE dash
  // that follows such a character: ` -eyJ…`), so every run is read a bounded number of times (linear).
  [/(?<![A-Za-z0-9_]|[A-Za-z0-9_-]-)eyJ[A-Za-z0-9_-]{8,8000}\.[A-Za-z0-9_-]{8,8000}\.[A-Za-z0-9_-]{8,8000}/g, `${M}jwt${M}`],
]

/** Every pattern, for the timing test (test/mask.test.js: 1 MB of crafted text per pattern). */
export const PATTERNS = () => [...TOKENS.map(([re]) => re), KV, URL_CRED, PEM_BEGIN, PEM_END]

// credentials inside URLs: scheme://user:password@host (scheme anchored and short, parts bounded)
const URL_CRED = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,20}:\/\/[^\s:/@]{1,256}):([^\s@/]{1,256})@/g

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g
const PEM_MAX = 20000
const PEM_HIDDEN = '[private key hidden]'

/**
 * Private keys: BEGIN..END (within 20000 characters) becomes one marker. A BEGIN without END hides the BEGIN line and
 * the key-looking lines right after it, nothing else. Linear: the END markers are found once.
 * @param {string} text @returns {{ text: string, n: number }}
 */
function maskPem(text) {
  if (!text.includes('PRIVATE KEY-----')) return { text, n: 0 }
  /** @type {Array<[number, number]>} */
  const ends = []
  for (const m of text.matchAll(PEM_END)) ends.push([/** @type {number} */ (m.index), m[0].length])
  let out = ''
  let pos = 0
  let n = 0
  let ei = 0
  PEM_BEGIN.lastIndex = 0
  /** @type {RegExpExecArray | null} */
  let m
  while ((m = PEM_BEGIN.exec(text))) {
    const start = m.index
    if (start < pos) continue
    const after = start + m[0].length
    while (ei < ends.length && ends[ei][0] < after) ei++
    out += text.slice(pos, start) + PEM_HIDDEN
    n++
    if (ei < ends.length && ends[ei][0] - after <= PEM_MAX) {
      pos = ends[ei][0] + ends[ei][1]
      ei++
    } else {
      // no END marker: hide the key-looking lines that follow, keep everything else
      const rest = text.slice(after).match(/^(?:[ \t]*\r?\n[ \t]*[A-Za-z0-9+/=]{16,100}[ \t]*){0,400}/)
      pos = after + (rest ? rest[0].length : 0)
    }
    PEM_BEGIN.lastIndex = Math.max(pos, start + 1)
  }
  return { text: out + text.slice(pos), n }
}

/**
 * @param {string} text
 * @returns {{ text: string, masked: boolean, flagged: boolean }}
 */
export function maskInfo(text) {
  if (typeof text !== 'string' || !text) return { text: '', masked: false, flagged: false }
  let masked = false
  let flagged = false
  const pem = maskPem(text)
  let out = pem.text
  if (pem.n) masked = true
  out = out.replace(URL_CRED, (all, head, pass) => {
    if (SHELL.test(pass)) { flagged = true; return all }
    masked = true
    return `${head}:${M}@`
  })
  for (const [re, rep] of TOKENS) {
    out = out.replace(re, (...a) => { masked = true; return rep.replace(/\$(\d)/g, (_, i) => a[Number(i)] ?? '') })
  }
  out = out.replace(KV, (all, dash, name, q1, sep, val) => {
    const q = val[0] === '"' || val[0] === "'" ? val[0] : ''
    const bare = q ? val.slice(1, -1) : val
    if (!bare || /^\*+$/.test(bare)) return all
    const op = sep.trim()
    // `=` always counts; `:` and a space only for CLI flags or values that look like keys (prose stays readable)
    const keyLike = bare.length >= 12 || /[0-9_/+=@$!#%-]/.test(bare)
    if (op === '=' || (op === ':' && keyLike) || (op === '' && dash && keyLike) || (op === ':' && q)) {
      if (SHELL.test(bare)) { flagged = true; return all }
      masked = true
      return (dash || '') + name + q1 + sep + q + M + q
    }
    return all
  })
  return { text: out, masked, flagged }
}

/** @param {string} text @returns {string} */
export function mask(text) {
  return maskInfo(text).text
}
