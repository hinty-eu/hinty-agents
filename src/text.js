// @ts-check
// Text shaping for what the service sends: permission text, the one-line status (`👓` line), labels.
// Everything that leaves the computer goes through `mask` (N8) and the relay's length/character rules.
//
// Permission cards (security review point 3): `permText` returns `{ text, complete }`. `complete: false` means the card
// does NOT show everything that will run: something was cut, masked or left visible on purpose by the mask, invisible
// or control characters were removed, blank lines were folded, a field had a shape we do not know, or an executing
// tool carried fields we do not know. Such a card goes out with `perm.part: true` and the service itself refuses a
// remote "allow" for it (only "deny" and the terminal remain). Cuts always carry a visible marker.
import { mask, maskInfo } from './mask.js'

/** Instruction added to every session by the SessionStart hook while paired (plan D2, E0 T3). */
export const GLASSES_INSTRUCTION =
  'The user also follows this session on smart glasses that show only one short line. ' +
  'At the end of every response, add one final line that starts with 👓 followed by at most 60 characters: ' +
  'what you did, or what you are asking the user.'

export const LINE_MAX = 60
export const TEXT_MAX = 8000
/** every text is cut to this BEFORE masking, so no pattern ever runs on a huge input (security review point 5) */
export const PRE_MAX = 4 * TEXT_MAX
const GLASSES = '\u{1F453}'

// Characters that change how text looks without being visible text: direction controls (bidi), zero-width characters,
// word joiner and invisible operators, byte order mark, interlinear annotation.
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g
// C0 controls except tab and newline, DEL, C1 controls
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g

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
 * Line breaks normalised, control and invisible characters removed, at most two empty lines in a row.
 * @param {string} s @returns {{ text: string, changed: boolean }}
 */
export function cleanText(s) {
  let t = String(s ?? '').replace(/\r\n/g, '\n')
  const before = t
  t = t.replace(/[\r\u2028\u2029\u0085]/g, '\n')
    .replace(CONTROL, ' ')
    .replace(INVISIBLE, '')
    .replace(/\n(?:[ \t]*\n){3,}/g, '\n\n\n')
  return { text: t, changed: t !== before }
}

/** @param {number} n */
const num = (n) => n.toLocaleString('en-US')

/**
 * Cut with a visible marker.
 * @param {string} s @param {number} max @param {number} [total] the length before an earlier cut
 * @returns {{ s: string, cut: boolean }}
 */
export function piece(s, max, total = s.length) {
  if (s.length <= max && total <= s.length) return { s, cut: false }
  const keep = cutUnits(s, Math.max(0, max - 60))
  return { s: `${keep}\n[… cut: ${num(keep.length)} of ${num(total)} characters shown]`, cut: true }
}

/**
 * Text of a permission card: cut before the mask, masked, cleaned, cut to TEXT_MAX with a visible marker.
 * @param {string} s @returns {{ text: string, complete: boolean }}
 */
export function cardText(s) {
  const raw = String(s ?? '')
  let complete = true
  const pre = raw.length > PRE_MAX ? cutUnits(raw, PRE_MAX) : raw
  if (pre.length < raw.length) complete = false
  const m = maskInfo(pre)
  if (m.masked || m.flagged) complete = false
  const c = cleanText(m.text)
  if (c.changed) complete = false
  const total = raw.length - pre.length + c.text.length
  const p = piece(c.text, TEXT_MAX, total)
  if (p.cut) complete = false
  return { text: p.s, complete }
}

/**
 * Multi-line text for the relay (last answers): cut before the mask, masked, cleaned, at most TEXT_MAX units.
 * @param {string} s
 */
export function relayText(s) {
  const raw = String(s ?? '')
  const clean = cleanText(mask(raw.length > PRE_MAX ? cutUnits(raw, PRE_MAX) : raw)).text
  if (clean.length <= TEXT_MAX) return clean
  return cutUnits(clean, TEXT_MAX - 1) + '…'
}

/**
 * One line, no control or invisible characters (also no terminal escape sequences), at most `max` code points
 * (with … when cut). Used for everything printed to a terminal or a log that came from outside.
 * @param {unknown} s @param {number} max
 */
export function oneLine(s, max) {
  const str = String(s ?? '')
  const flat = cutUnits(str, Math.max(64, max * 8))
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ').trim()
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
  // the last line holding a 👓 with text after it, searched from the end (a huge answer is never split into lines)
  let pos = text.lastIndexOf(GLASSES)
  while (pos >= 0) {
    const lineStart = text.lastIndexOf('\n', pos) + 1
    let lineEnd = text.indexOf('\n', pos)
    if (lineEnd < 0) lineEnd = text.length
    const line = text.slice(lineStart, lineEnd)
    const rest = cutUnits(line.slice(line.lastIndexOf(GLASSES) + GLASSES.length), 400).replace(/^[\s:\-–—*_`>]+/, '').replace(/[*_`]+$/g, '')
    if (rest.trim()) return oneLine(mask(rest), LINE_MAX)
    pos = lineStart > 0 ? text.lastIndexOf(GLASSES, lineStart - 1) : -1
  }
  const plain = cutUnits(text, 4000)
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(#{1,6}|[-*+>]|\d+[.)])\s+/, '').replace(/[*_`]/g, '').trim())
    .filter(Boolean)
    .join(' ')
  const first = plain.split(/(?<=[.!?])\s/)[0] || plain
  return oneLine(mask(cutUnits(first, 400)), LINE_MAX)
}

// ------------------------------------------------------------------------------------------------
// Permission cards
// ------------------------------------------------------------------------------------------------

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
/** @param {unknown} v */
const json = (v) => { try { return JSON.stringify(v, null, 2) ?? String(v) } catch { return String(v) } }
/** @param {Record<string, any>} o @param {string[]} known */
const extraKeys = (o, known) => Object.keys(o).filter((k) => !known.includes(k) && o[k] !== undefined)
/** @param {Record<string, any>} o @param {string[]} keys */
const restJson = (o, keys) => (keys.length ? `\n\nother fields:\n${json(Object.fromEntries(keys.map((k) => [k, o[k]])))}` : '')

const SHELL_KEYS = ['command', 'description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox']

/**
 * The card for one tool call: what the viewer sees under "<label> · <tool>": the command, the file and the change,
 * the URL... Every field of the input is on the card (known ones laid out, others as JSON).
 * @param {string} tool @param {unknown} input
 * @returns {{ text: string, complete: boolean }}
 */
export function permText(tool, input) {
  const r = buildCard(tool, input)
  return finishCard(r.text, r.complete, tool)
}

/**
 * Mask, clean and cut a card's text; an empty card is never complete.
 * @param {string} text @param {boolean} complete @param {string} tool
 */
export function finishCard(text, complete, tool) {
  const c = cardText(text)
  const t = c.text.trim()
  if (!t) return { text: `(${oneLine(tool, 40)})`, complete: false }
  return { text: t, complete: complete && c.complete }
}

/** @param {string} tool @param {unknown} input @returns {{ text: string, complete: boolean }} */
function buildCard(tool, input) {
  const s = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '')
  if (!isObj(input)) return { text: json(input), complete: input === undefined || input === null ? false : true }
  const i = input
  /** @param {string} t @param {boolean} [ok] */
  const done = (t, ok = true) => ({ text: t, complete: ok })
  switch (tool) {
    case 'Bash':
    case 'PowerShell': {
      let cmd = ''
      let ok = true
      if (typeof i.command === 'string') cmd = i.command
      else if (Array.isArray(i.command) && i.command.every((x) => typeof x === 'string')) cmd = JSON.stringify(i.command)
      else return done(json(i), false)
      const flags = [
        i.run_in_background === true ? '[runs in the background]' : '',
        i.dangerouslyDisableSandbox === true ? '[sandbox OFF]' : '',
        typeof i.timeout === 'number' ? `[timeout ${i.timeout} ms]` : '',
      ].filter(Boolean)
      if (i.description !== undefined && typeof i.description !== 'string') ok = false
      const extra = extraKeys(i, SHELL_KEYS)
      if (extra.length) ok = false
      return done(cmd + (flags.length ? `\n${flags.join(' ')}` : '') + (s(i.description) ? `\n\n# ${s(i.description)}` : '') + restJson(i, extra), ok)
    }
    case 'apply_patch': {
      const parts = ['command', 'input', 'patch'].filter((k) => typeof i[k] === 'string')
      const extra = extraKeys(i, ['command', 'input', 'patch'])
      if (!parts.length) return done(json(i), false)
      return done(parts.map((k) => (parts.length > 1 ? `[${k}]\n${i[k]}` : i[k])).join('\n\n') + restJson(i, extra), !extra.length)
    }
    case 'Write': {
      if (typeof i.file_path !== 'string' || typeof i.content !== 'string') return done(json(i), false)
      const extra = extraKeys(i, ['file_path', 'content'])
      const c = piece(i.content, 7000)
      return done(`${i.file_path}\n\n${c.s}${restJson(i, extra)}`, !c.cut && !extra.length)
    }
    case 'Edit': {
      if (typeof i.file_path !== 'string' || typeof i.old_string !== 'string' || typeof i.new_string !== 'string') return done(json(i), false)
      const extra = extraKeys(i, ['file_path', 'old_string', 'new_string', 'replace_all'])
      const a = piece(i.old_string, 3500)
      const b = piece(i.new_string, 3500)
      return done(`${i.file_path}${i.replace_all === true ? '  [replace EVERY occurrence]' : ''}\n--- replace:\n${a.s}\n+++ with:\n${b.s}${restJson(i, extra)}`,
        !a.cut && !b.cut && !extra.length)
    }
    case 'MultiEdit': {
      const edits = i.edits
      if (typeof i.file_path !== 'string' || !Array.isArray(edits) || !edits.length ||
        !edits.every((e) => isObj(e) && typeof e.old_string === 'string' && typeof e.new_string === 'string' &&
          !extraKeys(e, ['old_string', 'new_string', 'replace_all']).length)) return done(json(i), false)
      const extra = extraKeys(i, ['file_path', 'edits'])
      const per = Math.max(200, Math.floor(7000 / (edits.length * 2)))
      let cut = false
      const body = edits.map((e, n) => {
        const a = piece(e.old_string, per)
        const b = piece(e.new_string, per)
        if (a.cut || b.cut) cut = true
        return `--- edit ${n + 1} of ${edits.length}${e.replace_all === true ? ' [replace EVERY occurrence]' : ''}, replace:\n${a.s}\n+++ with:\n${b.s}`
      }).join('\n')
      return done(`${i.file_path} (${edits.length} edits)\n${body}${restJson(i, extra)}`, !cut && !extra.length)
    }
    case 'NotebookEdit': {
      if (typeof i.notebook_path !== 'string' || (i.new_source !== undefined && typeof i.new_source !== 'string')) return done(json(i), false)
      const extra = extraKeys(i, ['notebook_path', 'new_source', 'cell_id', 'cell_type', 'edit_mode'])
      const head = [i.notebook_path, i.cell_id !== undefined ? `cell ${s(i.cell_id) || json(i.cell_id)}` : '', s(i.edit_mode), s(i.cell_type)].filter(Boolean).join('  ')
      const c = piece(s(i.new_source), 7000)
      return done(`${head}\n\n${c.s}${restJson(i, extra)}`, !c.cut && !extra.length)
    }
    case 'WebFetch':
      if (typeof i.url !== 'string') return done(json(i), false)
      return done(`${i.url}${s(i.prompt) ? `\n\n${s(i.prompt)}` : ''}${restJson(i, extraKeys(i, ['url', 'prompt']))}`)
    case 'WebSearch':
      if (typeof i.query !== 'string') return done(json(i), false)
      return done(`${i.query}${restJson(i, extraKeys(i, ['query']))}`)
    case 'Read':
    case 'Glob':
    case 'Grep': {
      const main = ['file_path', 'pattern', 'path'].filter((k) => typeof i[k] === 'string')
      return done(main.map((k) => i[k]).join('  ') + restJson(i, extraKeys(i, main)))
    }
    default:
      // anything else (MCP tools, new tools): the whole input
      return done(json(i))
  }
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

/**
 * Text of a `say` from the relay before it goes anywhere (security review point 10): control characters other than
 * tab and newline and the invisible direction / zero-width characters removed (a NUL would break `codex queue`),
 * line breaks normalised. Then `safeInstruction` (N12).
 * @param {string} text
 */
export function sayText(text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n').replace(/[\r\u2028\u2029\u0085]/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(INVISIBLE, '')
  return safeInstruction(t)
}
