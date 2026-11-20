// @ts-check
// "Away from desk" mode (N5, D11). Off by default and after every start of the service. While off, nothing about
// the agents leaves this computer and the permission hook answers at once with an empty result. Turns itself off
// after 12 hours.

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
    /** @type {any} */
    this.timer = null
  }

  isOn() {
    if (this.on && this.now() >= this.until) this.set(false, 'timeout')
    return this.on
  }

  /** @param {boolean} on @param {string} why @returns {boolean} changed */
  set(on, why) {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null }
    if (on) {
      this.until = this.now() + this.maxMs
      this.timer = this.setTimer(() => this.set(false, 'timeout'), this.maxMs)
    } else {
      this.until = 0
    }
    const changed = this.on !== on
    this.on = on
    if (changed) this.onChange(on, why)
    return changed
  }
}
