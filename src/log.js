// @ts-check
// Service log: one line per event, identifiers and numbers only, never the text of a command or an answer.
// Values are made single-line and short (security review point 10: a value from the network cannot add a fake line).
import fs from 'node:fs'
import { noteCreated } from './store.js'

/** @param {string | number | boolean | null} v */
const clean = (v) => String(v).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').slice(0, 200)

const MAX = 1024 * 1024

/**
 * @param {string | null} file  null = no log (tests)
 * @returns {(msg: string, fields?: Record<string, string | number | boolean | null | undefined>) => void}
 */
export function createLog(file) {
  if (!file) return () => {}
  return (msg, fields = {}) => {
    try {
      try { if (fs.statSync(file).size > MAX) { fs.renameSync(file, file + '.1'); noteCreated(file + '.1') } } catch { /* no file yet */ }
      const extra = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${clean(/** @type {any} */ (v))}`).join(' ')
      fs.appendFileSync(file, `${new Date().toISOString()} ${msg}${extra ? ' ' + extra : ''}\n`, { mode: 0o600 })
      noteCreated(file)
    } catch { /* logging never breaks the service */ }
  }
}
