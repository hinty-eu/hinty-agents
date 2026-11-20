// @ts-check
// Small crypto helpers shared by the service, the CLI and the tests.
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** One-time permission request id: 128 random bits, base64url (22 chars). */
export const newRid = () => randomBytes(16).toString('base64url')

/** Secret for the local HTTP port (256 bits). */
export const newSecret = () => randomBytes(32).toString('base64url')

/** @param {string} s */
export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

/**
 * Deterministic JSON: object keys sorted, `undefined` members left out.
 * Used for the permission hash, so the same request always hashes the same way.
 * @param {unknown} v
 * @returns {string}
 */
export function canonical(v) {
  if (v === null || typeof v !== 'object') {
    const s = JSON.stringify(v)
    return s === undefined ? 'null' : s
  }
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  const o = /** @type {Record<string, unknown>} */ (v)
  return '{' + Object.keys(o).sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + canonical(o[k]))
    .join(',') + '}'
}

/**
 * N3: the hash the service sends with `perm` and checks on `decide`. It binds the decision to this exact request
 * (its one-time id) and to what the agent asked to run (session, sub-agent, tool and the tool's input as received).
 * @param {{ rid: string, sid: string, agentId?: string | null, tool: string, input: unknown }} p
 */
export const permHash = (p) => sha256(canonical({
  v: 1, rid: p.rid, sid: p.sid, agent_id: p.agentId ?? null, tool_name: p.tool, tool_input: p.input ?? null,
}))

/**
 * Constant-time string comparison (different lengths are simply unequal).
 * @param {unknown} a @param {unknown} b
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const A = Buffer.from(a, 'utf8')
  const B = Buffer.from(b, 'utf8')
  return A.length === B.length && timingSafeEqual(A, B)
}

/**
 * Proof that a local HTTP answer comes from the service that holds the secret (the hook and the mod check it, so a
 * process squatting a stale port cannot answer for the service).
 * @param {string} secret @param {string} nonce @param {string} body
 */
export const proof = (secret, nonce, body) => createHmac('sha256', secret).update(nonce + '\n' + body, 'utf8').digest('hex')
