// @ts-check
// N8: hide obvious secrets before any text leaves the computer (permission text, status line, last answer).
// Best effort: it catches well-known token formats and `key=value` assignments, not every secret there is.

const M = '***'

/** @type {Array<[RegExp, string | ((...m: string[]) => string)]>} */
const RULES = [
  // PEM private keys, whole block
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[private key hidden]'],
  // credentials inside URLs: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, `$1:${M}@`],
  // Authorization headers
  [/\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{8,}/g, `$1$2${M}`],
  // provider tokens with a recognisable prefix (keep the prefix, hide the rest)
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
  // JSON Web Tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, `${M}jwt${M}`],
  // NAME=value, NAME: value, --name value for secret-looking names (quoted or bare value)
  [/((?:^|[^A-Za-z0-9])(--?)?([A-Za-z0-9_.-]*?(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth)[A-Za-z0-9_.-]*)(["']?)(\s*(?:=|:|\s)\s*))("[^"\n]*"|'[^'\n]*'|[^\s"',;&|)]+)/gi,
    (all, head, dash, _name, _q, sep, val) => {
      const q = val[0] === '"' || val[0] === "'" ? val[0] : ''
      const bare = q ? val.slice(1, -1) : val
      if (!bare || /^\*+$/.test(bare)) return all
      const op = sep.trim()
      // `=` always counts; `:` and a space only for CLI flags or values that look like keys (prose stays readable)
      const keyLike = bare.length >= 12 || /[0-9_/+=@$!#%-]/.test(bare)
      if (op === '=' || (op === ':' && keyLike) || (op === '' && dash && keyLike) || (op === ':' && q)) {
        return head + q + M + q
      }
      return all
    }],
]

/**
 * @param {string} text
 * @returns {string}
 */
export function mask(text) {
  if (typeof text !== 'string' || !text) return ''
  let out = text
  for (const [re, rep] of RULES) out = out.replace(re, /** @type {any} */ (rep))
  return out
}
