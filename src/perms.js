// @ts-check
// Pending permission requests (N1, N3). Pure: no network, no timers; the service drives it with `now()`.
//
// A request is created when a PermissionRequest hook reaches the service while "away" mode is on. It ends exactly once:
// decided from the glasses/panel (allow|deny), answered at the keyboard (`local`), expired, refused by the relay,
// cancelled (the hook went away), or released (away turned off, link lost, service stopping).
// Only `decided` ends with a decision for the hook; every other end gives the hook an empty result (N1, D8).
import { newRid, permHash, safeEqual } from './crypto.js'

/**
 * @typedef {{ rid: string, hash: string, sid: string, agentKey: string, tool: string, text: string,
 *   createdAt: number, expiresAt: number }} Perm
 * @typedef {{ ok: true, perm: Perm, d: 'allow' | 'deny' } | { ok: false, reason: string }} DecideResult
 */

export class PermTable {
  /** @param {{ now?: () => number, rid?: () => string }} [o] */
  constructor(o = {}) {
    this.now = o.now || Date.now
    this.rid = o.rid || newRid
    /** @type {Map<string, Perm>} */
    this.pending = new Map()
    /** rid -> time it was used up (decided or ended); a used rid never comes back */
    /** @type {Map<string, number>} */
    this.spent = new Map()
  }

  /**
   * @param {{ sid: string, agentId?: string | null, tool: string, input: unknown, text: string, ttlMs: number }} p
   * @returns {Perm}
   */
  create(p) {
    let rid = this.rid()
    while (this.pending.has(rid) || this.spent.has(rid)) rid = this.rid()
    const now = this.now()
    const perm = {
      rid,
      hash: permHash({ rid, sid: p.sid, agentId: p.agentId ?? null, tool: p.tool, input: p.input }),
      sid: p.sid,
      agentKey: p.agentId || '',
      tool: p.tool,
      text: p.text,
      createdAt: now,
      expiresAt: now + p.ttlMs,
    }
    this.pending.set(rid, perm)
    return perm
  }

  /**
   * N3: accept a decision only when away mode is on, the rid is ours and still waiting, it has not expired and the
   * hash matches what we sent. A wrong hash does not use the request up (the person can still answer it).
   * @param {unknown} raw  the relay's `decide` payload, exactly {rid, d, hash}
   * @param {{ away: boolean }} ctx
   * @returns {DecideResult}
   */
  decide(raw, ctx) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'invalid' }
    const o = /** @type {Record<string, unknown>} */ (raw)
    const keys = Object.keys(o).sort().join(',')
    if (keys !== 'd,hash,rid') return { ok: false, reason: 'invalid' }
    const { rid, d, hash } = o
    if (typeof rid !== 'string' || typeof hash !== 'string') return { ok: false, reason: 'invalid' }
    if (d !== 'allow' && d !== 'deny') return { ok: false, reason: 'invalid' }
    if (!ctx.away) return { ok: false, reason: 'away_off' }
    const perm = this.pending.get(rid)
    if (!perm) return { ok: false, reason: this.spent.has(rid) ? 'spent' : 'unknown' }
    if (this.now() >= perm.expiresAt) {
      this.finish(rid)
      return { ok: false, reason: 'expired' }
    }
    if (!safeEqual(hash, perm.hash)) return { ok: false, reason: 'bad_hash' }
    this.finish(rid)
    return { ok: true, perm, d }
  }

  /** @param {string} rid @returns {Perm | null} */
  finish(rid) {
    const p = this.pending.get(rid)
    if (!p) return null
    this.pending.delete(rid)
    this.spent.set(rid, this.now())
    return p
  }

  /** @returns {Perm[]} requests whose time is up */
  expired() {
    const now = this.now()
    return [...this.pending.values()].filter((p) => now >= p.expiresAt)
  }

  /**
   * Requests answered at the keyboard (E0: the keyboard answer does not end the waiting hook). Any later activity of
   * the same session and the same (sub)agent means the prompt is gone. A main-loop turn end closes the main loop's
   * requests; a sub-agent's turn end closes that sub-agent's.
   * @param {{ sid: string, agentKey: string, at: number }} ev
   * @returns {Perm[]}
   */
  localActivity(ev) {
    return [...this.pending.values()].filter((p) => p.sid === ev.sid && p.agentKey === ev.agentKey && ev.at > p.createdAt)
  }

  /** @param {(p: Perm) => boolean} [pred] */
  list(pred) {
    const all = [...this.pending.values()]
    return pred ? all.filter(pred) : all
  }

  /** Forget used rids after 2 h (the relay keeps them as long). */
  sweepSpent() {
    const cut = this.now() - 2 * 60 * 60 * 1000
    for (const [rid, at] of this.spent) if (at < cut) this.spent.delete(rid)
  }
}
