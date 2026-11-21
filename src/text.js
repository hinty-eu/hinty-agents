// @ts-check
// Text shaping for what the service sends: permission text, the one-line status (`👓` line), labels.
// Everything that leaves the computer goes through `mask` (N8) and the relay's length/character rules.
import { mask } from './mask.js'

/** Instruction added to every session by the SessionStart hook while paired (plan D2, E0 T3). */
export const GLASSES_INSTRUCTION =
  'The user also follows this session on smart glasses that show only one short line. ' +
  'At the end of every response, add one final line that starts with 👓 followed by at most 60 characters: ' +
  'what you did, or what you are asking the user.'

export const LINE_MAX = 60
export const TEXT_MAX = 8000
const GLASSES = '\u{1F453}'

/**
 * Cut to at most `max` UTF-16 units without splitting a surrogate pair.
 * @param {string} s @param {number} max
 */
export function cutUnits(s, max) {
  if (s.length <= max) return s
  let out = s.slice(0, max)
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

/**
 * Multi-line text for the relay: only \t \n \r among control characters, masked, at most TEXT_MAX units.
 * @param {string} s
 */
export function relayText(s) {
  const clean = mask(String(s ?? ''))
    .replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
  if (clean.length <= TEXT_MAX) return clean
  return cutUnits(clean, TEXT_MAX - 1) + '…'
}

/**
 * One line, no control characters, at most `max` code points (with … when cut).
 * @param {string} s @param {number} max
 */
export function oneLine(s, max) {
  const flat = String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim()
  const cps = Array.from(flat)
  if (cps.length <= max) return flat
  return cps.slice(0, Math.max(0, max - 1)).join('').trimEnd() + '…'
}

/**
 * The `👓` line from the agent's final answer (plan D2): the text after the last `👓`, at most 60 characters;
 * fallback: the first sentence of the answer.
 * @param {string} answer
 */
export function glassesLine(answer) {
  const text = String(answer ?? '')
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].lastIndexOf(GLASSES)
    if (at < 0) continue
    const rest = lines[i].slice(at + GLASSES.length).replace(/^[\s:\-–—*_`>]+/, '').replace(/[*_`]+$/g, '')
    if (rest.trim()) return oneLine(mask(rest), LINE_MAX)
  }
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(#{1,6}|[-*+>]|\d+[.)])\s+/, '').replace(/[*_`]/g, '').trim())
    .filter(Boolean)
    .join(' ')
  const first = plain.split(/(?<=[.!?])\s/)[0] || plain
  return oneLine(mask(first), LINE_MAX)
}

/**
 * What the viewer sees under "<label> · <tool>": the command, the file, the URL...
 * @param {string} tool @param {unknown} input
 */
export function permText(tool, input) {
  const i = /** @type {Record<string, any>} */ (input && typeof input === 'object' ? input : {})
  const s = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '')
  let out
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      out = s(i.command) + (s(i.description) ? `\n\n# ${s(i.description)}` : '')
      break
    case 'apply_patch':
      out = s(i.command) || s(i.input)
      break
    case 'Write':
      out = `${s(i.file_path)}\n\n${s(i.content).slice(0, 3000)}`
      break
    case 'Edit':
      out = `${s(i.file_path)}\n\n- ${s(i.old_string).slice(0, 1500)}\n+ ${s(i.new_string).slice(0, 1500)}`
      break
    case 'MultiEdit':
      out = `${s(i.file_path)} (${Array.isArray(i.edits) ? i.edits.length : 0} edits)`
      break
    case 'NotebookEdit':
      out = `${s(i.notebook_path)}\n\n${s(i.new_source).slice(0, 3000)}`
      break
    case 'WebFetch':
      out = `${s(i.url)}${s(i.prompt) ? `\n\n${s(i.prompt)}` : ''}`
      break
    case 'WebSearch':
      out = s(i.query)
      break
    case 'Read':
    case 'Glob':
    case 'Grep':
      out = [s(i.file_path), s(i.pattern), s(i.path)].filter(Boolean).join('  ')
      break
    default:
      try { out = JSON.stringify(input, null, 2) } catch { out = '' }
  }
  out = relayText(out || '').trim()
  return out || `(${oneLine(tool, 40)})`
}

/**
 * Session label from the working directory: the folder's name (plan §4.1); `-2`, `-3`... are added by the caller.
 * @param {string} cwd
 */
export function baseLabel(cwd) {
  const name = String(cwd || '').split(/[\\/]+/).filter(Boolean).pop() || 'session'
  return oneLine(name, 50) || 'session'
}

const TRIGGERS = new Set(['/', '!', '#', '@', '$'])

/**
 * An instruction from the glasses or panel must reach an agent as a plain message, never as a command: Claude Code reads
 * `!` as bash mode, `/` as a slash command and `#` as a memory note; OpenClaw runs `/approve <id> allow-always` sent as
 * chat text. For EVERY line that, after leading white space (any Unicode `\s`), starts with / ! # @ or $, the white space
 * is removed and a zero-width space is put in front. Other text is returned byte for byte.
 * @param {string} text
 */
export function safeInstruction(text) {
  return String(text ?? '')
    .split(/(\r\n|[\r\n\u000b\u000c\u0085\u2028\u2029])/)
    .map((part, i) => {
      if (i % 2 === 1) return part // the separators
      const bare = part.replace(/^\s+/u, '')
      return bare && TRIGGERS.has(bare[0]) ? `\u200b${bare}` : part
    })
    .join('')
}
