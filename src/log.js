// @ts-check
// Service log: one line per event, identifiers and numbers only, never the text of a command or an answer.
import fs from 'node:fs'

const MAX = 1024 * 1024

/**
 * @param {string | null} file  null = no log (tests)
 * @returns {(msg: string, fields?: Record<string, string | number | boolean | null | undefined>) => void}
 */
export function createLog(file) {
  if (!file) return () => {}
  return (msg, fields = {}) => {
    try {
      try { if (fs.statSync(file).size > MAX) fs.renameSync(file, file + '.1') } catch { /* no file yet */ }
      const extra = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(' ')
      fs.appendFileSync(file, `${new Date().toISOString()} ${msg}${extra ? ' ' + extra : ''}\n`, { mode: 0o600 })
    } catch { /* logging never breaks the service */ }
  }
}
