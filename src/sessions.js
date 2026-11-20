// @ts-check
// Agent sessions known on this computer. Kept locally whatever the mode; only sent out while away mode is on (N5).
import { baseLabel } from './text.js'

/**
 * @typedef {'run' | 'perm' | 'ask' | 'done' | 'idle' | 'err' | 'end'} SessState
 * @typedef {{ sid: string, agent: string, cwd: string, label: string, st: SessState, line: string, at: number,
 *   seenAt: number, modSeenAt: number, interactive: boolean | null, answer: string }} Session
 */

export const SID_RE = /^[\x21-\x7e]{1,64}$/

/** A session whose mod stopped polling is gone after this long (the poll comes back every ~20 s). */
export const MOD_GONE_MS = 90 * 1000
/** A session seen only through hooks (mods off) is forgotten after this long without news. */
export const HOOK_ONLY_TTL_MS = 30 * 60 * 1000

export class SessionTable {
  /** @param {{ now?: () => number }} [o] */
  constructor(o = {}) {
    this.now = o.now || Date.now
    /** @type {Map<string, Session>} */
    this.map = new Map()
  }

  /** @param {string} sid */
  get(sid) { return this.map.get(sid) || null }

  list() { return [...this.map.values()] }

  /**
   * Register or touch a session. Label: the folder's name, `-2`, `-3`... when another live session has it.
   * @param {{ sid: string, cwd?: string, agent?: string, fromMod?: boolean, interactive?: boolean }} p
   * @returns {{ s: Session, isNew: boolean }}
   */
  touch(p) {
    const now = this.now()
    let s = this.map.get(p.sid)
    const isNew = !s
    if (!s) {
      const cwd = typeof p.cwd === 'string' ? p.cwd : ''
      s = {
        sid: p.sid, agent: p.agent || 'claude', cwd, label: this.freeLabel(baseLabel(cwd)), st: 'idle', line: '',
        at: now, seenAt: now, modSeenAt: 0, interactive: null, answer: '',
      }
      this.map.set(p.sid, s)
    }
    s.seenAt = now
    if (p.fromMod) s.modSeenAt = now
    if (typeof p.interactive === 'boolean') s.interactive = p.interactive
    if (!s.cwd && typeof p.cwd === 'string' && p.cwd) { s.cwd = p.cwd; s.label = this.freeLabel(baseLabel(p.cwd), s.sid) }
    return { s, isNew }
  }

  /** @param {string} base @param {string} [self] */
  freeLabel(base, self) {
    const taken = new Set([...this.map.values()].filter((x) => x.sid !== self).map((x) => x.label))
    if (!taken.has(base)) return base
    for (let n = 2; n < 1000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
    return `${base}-${Date.now() % 10000}`
  }

  /**
   * @param {string} sid @param {{ st?: SessState, line?: string }} patch
   * @returns {boolean} changed
   */
  set(sid, patch) {
    const s = this.map.get(sid)
    if (!s) return false
    let changed = false
    if (patch.st && patch.st !== s.st) { s.st = patch.st; changed = true }
    if (typeof patch.line === 'string' && patch.line !== s.line) { s.line = patch.line; changed = true }
    if (changed) s.at = this.now()
    return changed
  }

  /** @param {string} sid @returns {Session | null} */
  remove(sid) {
    const s = this.map.get(sid)
    if (!s) return null
    this.map.delete(sid)
    return s
  }

  /** @returns {Session[]} sessions that are gone (mod stopped polling, or no news for 30 min without a mod) */
  sweep() {
    const now = this.now()
    const gone = []
    for (const s of this.map.values()) {
      const dead = s.modSeenAt ? now - s.modSeenAt > MOD_GONE_MS : now - s.seenAt > HOOK_ONLY_TTL_MS
      if (dead) gone.push(s)
    }
    for (const s of gone) this.map.delete(s.sid)
    return gone
  }

  /** Away mode turned off: forget everything that came from the agents' output (answers, status lines). */
  forgetContent() {
    for (const s of this.map.values()) { s.answer = ''; s.line = '' }
  }
}
