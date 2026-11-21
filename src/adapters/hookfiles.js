// @ts-check
// The hook scripts of the Codex and Grok adapters live in ~/.hinty-agents/hooks/ (a stable path: an `npx` cache folder
// may be cleaned later, and the agents' hook files point to these copies). Install copies them, uninstall of the last
// adapter that uses them leaves them (they are tiny and harmless without a hook entry).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureHome, homeDir } from '../store.js'

export const SCRIPTS = ['common.cjs', 'codex-hook.cjs', 'grok-hook.cjs']

export const sourceDir = () => path.resolve(fileURLToPath(new URL('../../hooks/', import.meta.url)))
export const hooksDir = () => path.join(homeDir(), 'hooks')

/** Copy the scripts into the data folder; returns the folder. */
export function installScripts() {
  ensureHome()
  const dest = hooksDir()
  fs.mkdirSync(dest, { recursive: true })
  for (const f of SCRIPTS) fs.copyFileSync(path.join(sourceDir(), f), path.join(dest, f))
  return dest
}

/** Quote a path for a command line (the agents run `command` through a shell). Forward slashes work on Windows too. */
export function q(/** @type {string} */ p) {
  return `"${p.replace(/\\/g, '/').replace(/"/g, '')}"`
}
