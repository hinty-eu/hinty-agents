// @ts-check
// The registry of adapters (plan §4 "AgentAdapter"). Everything that used to say `claude` by hand (hello.agents,
// install / uninstall, doctor, status) goes through here. Adding an agent = one module + one line below.
//
// Common shape of an adapter module:
//   id, caps { perm, say }, detect() -> { found, version }, install(opts) / uninstall() -> { ok, steps },
//   installed() -> { installed, ... }.
// Agents with hooks also export a pure `normalize(input)` that turns the agent's hook input into the service's common
// shape; the service's `agentHook*` methods use it, so the agent's field names live only in the adapter.
import * as claude from './claude.js'
import * as codex from './codex.js'
import * as grok from './grok.js'

/** @type {Record<string, any>} */
export const ADAPTERS = { claude, codex, grok }

export const ids = () => Object.keys(ADAPTERS)

/** @param {string | undefined} id */
export const get = (id) => (id && Object.prototype.hasOwnProperty.call(ADAPTERS, id) ? ADAPTERS[id] : null)

/**
 * The names for `hello.agents`: Claude Code always (it is the original agent and its plugin is checked by `doctor`),
 * every other agent once its hooks are installed. Cheap: reads two small files, runs no process.
 * @returns {string[]}
 */
export function activeAgents() {
  const out = ['claude']
  try { if (codex.installed().installed) out.push('codex') } catch { /* unreadable hooks.json: not active */ }
  try { if (grok.installed().installed) out.push('grok') } catch { /* same */ }
  return out
}
