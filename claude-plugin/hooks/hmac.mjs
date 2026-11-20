// @ts-check
// HMAC-SHA-256 for the mod. The mod's environment offers only `crypto.subtle.digest`, so HMAC is built from it
// (RFC 2104). Used to check the local service's proof on every answer.

const enc = new TextEncoder()

/** @param {Uint8Array} bytes */
export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** @param {Uint8Array} bytes */
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))

/**
 * @param {string} secret @param {string} message
 * @returns {Promise<string>} lower-case hex
 */
export async function hmacSha256Hex(secret, message) {
  let key = enc.encode(secret)
  if (key.length > 64) key = await sha256(key)
  const k = new Uint8Array(64)
  k.set(key)
  const m = enc.encode(message)
  const inner = new Uint8Array(64 + m.length)
  for (let i = 0; i < 64; i++) inner[i] = (k[i] ?? 0) ^ 0x36
  inner.set(m, 64)
  const innerHash = await sha256(inner)
  const outer = new Uint8Array(64 + 32)
  for (let i = 0; i < 64; i++) outer[i] = (k[i] ?? 0) ^ 0x5c
  outer.set(innerHash, 64)
  return hex(await sha256(outer))
}

/** 128-bit random nonce, hex. */
export function nonce() {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return hex(b)
}
