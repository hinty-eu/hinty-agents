// @ts-check
// Where the code of hinty-agents lives right now. Normally the folder this file is in; after `ensureApp()` (app.js) it is
// the stable copy in ~/.hinty-agents/app/<version>. No imports from the rest of the package, so store.js, the adapters
// and app.js can all use it without cycles.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The package folder this file was loaded from (an npx cache folder, a git checkout or the stable copy). */
export const packageRoot = () => path.resolve(fileURLToPath(new URL('../', import.meta.url)))

/** @type {string | null} */
let active = null

/** The folder every path of the service, the hooks and the plugin marketplace is built from. */
export const activeRoot = () => active || packageRoot()

/** @param {string | null} root */
export function setActiveRoot(root) { active = root }
