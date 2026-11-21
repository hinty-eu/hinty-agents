// @ts-check
// "Away from desk" mode (N5, D11). Off by default and after every start of the service. While off, nothing about
// the agents leaves this computer and the permission hook answers at once with an empty result. Turns itself off
// after 12 hours, counted from the moment it was switched on; only a switch-on at this computer (`away on`) starts
// the 12 hours again, a remote one never extends them (security review point 2).

export const AWAY_MAX_MS = 12 * 60 * 60 * 1000

export class AwayMode {
  /**
   * @param {{ now?: () => number, maxMs?: number, onChange?: (on: boolean, why: string) => void,
   *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void }} [o]
   */
  constructor(o = {}) {
    this.now = o.now || Date.now
    this.maxMs = o.maxMs || AWAY_MAX_MS
    this.onChange = o.onChange || (() => {})
    this.setTimer = o.setTimer || ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = o.clearTimer || ((t) => clearTimeout(t))
    this.on = false
    this.until = 0
    /** when it was switched on (0 = off) and by whom ('cli', 'remote', ...) */
    this.since = 0
    this.by = ''
    /** @type {any} */
    this.timer = null
  }

  isOn() {
    if (this.on && this.now() >= this.until) this.set(false, 'timeout')
    return this.on
  }

  /**
   * @param {boolean} on @param {string} why
   * @param {{ renew?: boolean }} [o] renew (default true): switching on while already on starts the 12 h again
   * @returns {boolean} changed
   */
  set(on, why, o = {}) {
    if (on && this.on && o.renew === false) return false
    if (this.timer) { this.clearTimer(this.timer); this.timer = null }
    if (on) {
      this.until = this.now() + this.maxMs
      this.timer = this.setTimer(() => this.set(false, 'timeout'), this.maxMs)
      if (!this.on) { this.since = this.now(); this.by = why }
    } else {
      this.until = 0
      this.since = 0
      this.by = ''
    }
    const changed = this.on !== on
    this.on = on
    if (changed) this.onChange(on, why)
    return changed
  }
}
