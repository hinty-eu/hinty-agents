// @ts-check
// Command line: setup wizard, status, away mode, plugin install, doctor, unpair, start/stop.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import readline from 'node:readline'
import { call, pingOwn, status as daemonStatus } from './client.js'
import * as claude from './adapters/claude.js'
import { ADAPTERS, get as getAdapter } from './adapters/index.js'
import { childEnv, hardenEnv, isOurDaemonLine, processCommandLine, sysExe } from './exec.js'
import { hhmm } from './notify.js'
import { CHECK_TRIES, checkMatches, prettyCode, pair } from './pair.js'
import { Relay } from './relay.js'
import { DEFAULT_API, cliEntry, ensureHome, homeAccess, homeDir, isPaired, paths, pidAlive, readConfig, readDaemonAny, readDaemonInfo, updateConfig } from './store.js'
import { oneLine } from './text.js'
import { MODELS } from './stt/models.js'
import { fmtMB, installVoice, removeVoice, voiceStatus } from './stt/install.js'
import { VERSION } from './version.js'

const NAMES = /** @type {Record<string, string>} */ ({ codex: 'Codex CLI', grok: 'Grok Build', openclaw: 'OpenClaw', hermes: 'Hermes Agent' })
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms))
const out = (/** @type {string} */ s = '') => process.stdout.write(s + '\n')
const color = process.stdout.isTTY && !process.env.NO_COLOR
const c = {
  ok: (/** @type {string} */ s) => (color ? `\x1b[32m${s}\x1b[0m` : s),
  bad: (/** @type {string} */ s) => (color ? `\x1b[31m${s}\x1b[0m` : s),
  warn: (/** @type {string} */ s) => (color ? `\x1b[33m${s}\x1b[0m` : s),
  b: (/** @type {string} */ s) => (color ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (/** @type {string} */ s) => (color ? `\x1b[2m${s}\x1b[0m` : s),
}

const HELP = `hinty-agents ${VERSION}: approve your AI agents' steps from Hinty smart-glasses and the Hinty panel

Usage: npx hinty-agents [command]

  (no command)        set up: pair this computer, install the Claude Code plugin, start the service
  status              what runs, the link, away mode, known sessions
  away on|off         away-from-desk mode: while off nothing leaves this computer (it turns itself off after 12 h)
  remote-away on|off  allow (or not) switching away mode ON remotely from the Hinty panel or glasses (default off)
  install <agent>     claude: the plugin (hooks + mod) via Claude Code's plugin commands
                      codex: hooks merged into $CODEX_HOME/hooks.json (then trust them once: /hooks in Codex)
                      grok: ~/.grok/hooks/hinty.json; add --ask-shell to get a card for every shell command
                      openclaw: pairs once with your local Gateway (--token-file <file> if the token is a secret reference)
                      hermes: plugin into Hermes's plugins folder + 3 Hermes settings (undone by uninstall)
  uninstall <agent>   remove what install added (claude | codex | grok | openclaw | hermes)
  doctor              check Node, Claude Code, the plugin, the service and the link
  unpair              disconnect this computer from your Hinty account
  start | stop        start or stop the background service
  voice install       local speech to text for dictating to agents from the glasses (free, ~0.7 GB: --model <id>)
  voice status|remove show what is installed / delete the voice packages and models

Setup options: --no-install (skip the plugin), --no-start (do not start the service), --label <name>
Server: ${DEFAULT_API} (override with HINTY_AGENTS_API). Data: ~/.hinty-agents (override with HINTY_AGENTS_HOME).`

/** @param {string[]} argv @returns {Promise<number>} */
export async function main(argv) {
  // never run a program from the current folder (security review point 6)
  hardenEnv()
  const [cmd, ...rest] = argv
  // the data folder's access is narrowed (and read back) at every start, not only when it is created (review 2, Z7)
  if (fs.existsSync(homeDir())) { try { ensureHome() } catch { /* doctor reports it */ } }
  try {
    return await dispatch(cmd, rest, argv)
  } finally {
    closeInput()
  }
}

/** @param {string | undefined} cmd @param {string[]} rest @param {string[]} argv @returns {Promise<number>} */
async function dispatch(cmd, rest, argv) {
  switch (cmd) {
    case undefined:
    case 'setup':
      return setup(rest)
    case 'daemon': {
      const { runDaemon } = await import('./daemon.js')
      await runDaemon()
      return 0
    }
    case 'status': return showStatus()
    case 'away': return away(rest[0])
    case 'remote-away': return remoteAwayCmd(rest[0])
    case 'install': return installCmd(rest[0], rest.slice(1))
    case 'uninstall': return uninstallCmd(rest[0])
    case 'doctor': return doctor()
    case 'unpair': return unpair()
    case 'start': return start()
    case 'stop': return stop()
    case 'voice': return voice(rest)
    case '-v':
    case '--version':
    case 'version':
      out(VERSION)
      return 0
    case '-h':
    case '--help':
    case 'help':
      out(HELP)
      return 0
    default:
      if (cmd.startsWith('--')) return setup(argv)
      out(HELP)
      return 1
  }
}

/** API of this computer's pairing (stored at pairing); HINTY_AGENTS_API only picks the server for a new pairing. */
function apiFor(/** @type {import('./store.js').Config | null} */ cfg) {
  return (cfg && cfg.api) || process.env.HINTY_AGENTS_API || DEFAULT_API
}

function panelUrl(/** @type {string} */ api) {
  if (process.env.HINTY_AGENTS_WEB) return oneLine(process.env.HINTY_AGENTS_WEB, 200)
  return api === DEFAULT_API ? 'https://www.hinty.eu/dashboard/voice-assistant/agents' : null
}

// ------------------------------------------------------------------------------------------------
// Questions (one line from stdin, a terminal or a pipe; end of input = the default answer)
// ------------------------------------------------------------------------------------------------

/** @type {readline.Interface | null} */
let rl = null
/** @type {string[]} */
const lines = []
/** @type {Array<(l: string) => void>} */
const waiting = []
let inputClosed = false

/** @param {string} question @returns {Promise<string>} */
export function ask(question) {
  process.stdout.write(question)
  if (lines.length) return Promise.resolve(/** @type {string} */ (lines.shift()))
  if (inputClosed) { process.stdout.write('\n'); return Promise.resolve('') }
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, terminal: false })
    rl.on('line', (l) => { const w = waiting.shift(); if (w) w(l); else lines.push(l) })
    rl.on('close', () => { inputClosed = true; for (const w of waiting.splice(0)) w('') })
  }
  return new Promise((resolve) => waiting.push(resolve))
}

/**
 * Is a person at this terminal (stdin is a TTY)? HINTY_AGENTS_TEST_PIPED_INPUT=1 lets the end-to-end tests drive the
 * wizard through a pipe; whoever can set that variable for your wizard already controls this computer.
 */
export function interactive() {
  return !!process.stdin.isTTY || process.env.HINTY_AGENTS_TEST_PIPED_INPUT === '1'
}

/** @param {string} question @returns {Promise<boolean>} only y / yes counts */
export async function askYes(question) {
  return /^\s*(y|yes)\s*$/i.test(await ask(question))
}

function closeInput() {
  if (rl) { rl.close(); rl = null }
}

/** Is a service of ANOTHER version running (daemon.json of an older protocol, its pid our service)? */
function olderServicePid() {
  const any = readDaemonAny()
  if (!any || !any.old || !pidAlive(any.pid)) return 0
  return isOurDaemonLine(processCommandLine(any.pid)) ? any.pid : 0
}

/** The server may tell this bridge "unpaired" (a token it gave us that we do not keep). @param {string} api @param {string} token */
function tellServerUnpair(api, token) {
  const relay = new Relay({ api, token })
  return new Promise((resolve) => {
    const t = setTimeout(() => { relay.stop(); resolve(false) }, 8000)
    relay.on('relay', (ev) => {
      if (ev === 'ready') { relay.send('unpair'); setTimeout(() => { clearTimeout(t); relay.stop(); resolve(true) }, 800) }
      if (ev === 'invalid_token') { clearTimeout(t); relay.stop(); resolve(true) }
    })
    relay.start()
  })
}

const REMOTE_AWAY_TEXT = [
  'Away mode is what lets your glasses and the Hinty panel answer permission prompts and send instructions to your',
  'agents. You can always switch it on here: npx hinty-agents away on',
  '',
  'You can also allow switching it ON remotely (from the Hinty panel or your glasses).',
  'Risk: whoever gets into your Hinty account (or the Hinty server) could then switch it on while you are not at',
  'the desk and, with an agent session open, send it instructions and approve its steps on this computer.',
  'A remote switch-on is shown here (status line in Claude Code, a notification, `npx hinty-agents status`). It lasts',
  'at most until 12 hours after you last switched away mode on HERE or gave this consent; switching it off and on',
  'again remotely does not start the 12 hours again, and after them a remote switch-on is refused until you run',
  '`away on` or `remote-away on` here again. Switching away mode OFF remotely always works.',
  'Change it any time: npx hinty-agents remote-away on|off',
]

// ------------------------------------------------------------------------------------------------
// Service lifecycle
// ------------------------------------------------------------------------------------------------

/** @returns {Promise<any | null>} status of the running (or just started) service */
export async function startDaemon() {
  updateConfig({ stopped: false, entry: cliEntry() })
  const now = await daemonStatus()
  if (now) return now
  if (olderServicePid()) return null
  // started in the data folder, never in the folder this command runs in
  const child = spawn(process.execPath, [cliEntry(), 'daemon'], { detached: true, stdio: 'ignore', windowsHide: true, env: childEnv(), cwd: paths().home })
  child.unref()
  for (let i = 0; i < 80; i++) {
    await sleep(100)
    const s = await daemonStatus()
    if (s) return s
  }
  return null
}

async function start() {
  const cfg = readConfig()
  if (!isPaired(cfg)) { out('Not paired yet. Run: npx hinty-agents'); return 1 }
  const old = olderServicePid()
  if (old) { out(c.warn(`An older version of the service is running (pid ${old}). Stop it first: npx hinty-agents stop`)); return 1 }
  const s = await startDaemon()
  if (!s) { out(c.bad('The service did not start. See ' + paths().log)); return 1 }
  out(`${c.ok('✓')} Service running (pid ${s.pid}).`)
  return 0
}

/**
 * Stop the service. Security review point 7: the pid in daemon.json is killed only when it is our service (a signed
 * answer with the same pid, or the command line `node .../hinty-agents.js daemon`). After a reboot that pid may
 * belong to any other program: then only the stale files are removed.
 */
async function stop() {
  if (readConfig()) updateConfig({ stopped: true })
  const any = readDaemonAny()
  const removeFiles = () => {
    try { fs.unlinkSync(paths().daemon) } catch { /* gone */ }
    try { const l = Number(fs.readFileSync(paths().lock, 'utf8')); if (!pidAlive(l) || (any && l === any.pid)) fs.unlinkSync(paths().lock) } catch { /* gone */ }
  }
  if (!any) { out('The service is not running.'); return 0 }
  const pid = any.pid
  // review 2, Z13: only a signed answer with this pid proves the process is our service; a command line that looks
  // like ours does not (it may be another installation's service or anything named like it)
  const signed = !!any.info && pidAlive(pid) && await pingOwn(any.info)
  if (!signed) {
    const older = any.old && pidAlive(pid) && isOurDaemonLine(processCommandLine(pid))
    if (!older) removeFiles()
    out(older
      ? c.warn(`An older version of the service (pid ${pid}) may be running; it cannot prove it is the service, so it was not stopped. Stop it yourself (${process.platform === 'win32' ? `taskkill /PID ${pid} /T` : `kill ${pid}`}) if it is.`)
      : pidAlive(pid)
        ? `The service is not running (its old pid ${pid} now belongs to another program, which was left alone).`
        : 'The service is not running.')
    return 0
  }
  try { await call('POST', '/v1/stop') } catch { /* not answering */ }
  for (let i = 0; i < 40 && pidAlive(pid); i++) await sleep(100)
  if (pidAlive(pid)) {
    if (process.platform === 'win32') spawnSync(sysExe('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, cwd: os.homedir() })
    else { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
    await sleep(300)
  }
  if (!pidAlive(pid)) removeFiles()
  out(pidAlive(pid) ? c.bad(`The service (pid ${pid}) is still running.`) : `${c.ok('✓')} Service stopped. It will not start again until \`npx hinty-agents start\`.`)
  return pidAlive(pid) ? 1 : 0
}

// ------------------------------------------------------------------------------------------------
// Setup wizard
// ------------------------------------------------------------------------------------------------

/** @param {string[]} args */
async function setup(args) {
  const noInstall = args.includes('--no-install')
  const noStart = args.includes('--no-start')
  const li = args.indexOf('--label')
  const label = (li >= 0 && args[li + 1] ? args[li + 1] : os.hostname()).slice(0, 60)

  out(c.b(`Hinty Agents ${VERSION}`))
  out('Approve or deny your AI agents\' permission prompts and follow their sessions from Hinty smart-glasses')
  out('or the Hinty panel, while you are away from the desk.\n')

  out(`${c.ok('✓')} Node.js ${process.versions.node}`)
  const cc = claude.detect()
  if (cc.found) out(`${c.ok('✓')} Claude Code ${cc.version}`)
  else out(`${c.warn('!')} Claude Code not found (\`claude\`). Install it first to use the plugin: https://code.claude.com`)

  ensureHome()
  let cfg = readConfig()
  if (isPaired(cfg) && cfg) {
    out(`${c.ok('✓')} Already paired with ${cfg.api} as "${oneLine(cfg.label || '?', 60)}"${cfg.account ? ` (account ${cfg.account})` : ''} (to pair again: npx hinty-agents unpair)`)
  } else {
    const api = apiFor(null)
    if (!checkApi(api)) return 1
    // a person has to copy a number from the panel into this terminal (Z10): no terminal, no pairing
    if (!interactive()) {
      out(c.bad('\n✗ Pairing needs a person at this terminal: run `npx hinty-agents` in a terminal (not with piped input) and type the 4-digit number the Hinty panel shows.'))
      return 1
    }
    out(`\nPairing with ${api} ...`)
    let res
    try {
      res = await pair({
        api, label, host: os.hostname(),
        onCode: (code, expiresIn) => {
          const url = panelUrl(api)
          out('')
          out(`  Pairing code:  ${c.b(prettyCode(code))}`)
          out(url
            ? `  Open ${url} and type the code (valid ${Math.round(expiresIn / 60)} min).`
            : `  Type it in the Hinty panel: Voice Assistant -> Agents (valid ${Math.round(expiresIn / 60)} min).`)
          out('  The panel then shows a 4-digit number: you will type it here.')
          out(c.dim('  Waiting for the code to be entered... (Ctrl+C to cancel)'))
        },
      })
    } catch (e) {
      const m = /** @type {Error} */ (e).message
      const why = m === 'refused:off' ? 'Hinty Agents is not switched on on this server yet.'
        : m === 'refused:not_allowed' ? 'Hinty Agents is not available for this account yet.'
          : m === 'unreachable' ? `Cannot reach ${api}.`
            : m === 'pairing_timeout' ? 'No code was entered in time.' : m
      out(c.bad(`\n✗ Pairing failed: ${why}`))
      return 1
    }
    // review 2, Z10: whoever typed the code now steers this computer. The panel that typed it shows a 4-digit number;
    // only the person who typed the code in their OWN panel can copy it here. Anything else unpairs at once.
    const refuse = async (/** @type {string} */ why) => {
      const told = await tellServerUnpair(api, res.token)
      out(c.bad(`\n✗ ${why} This computer was ${told ? 'disconnected from that account again' : 'not kept; remove it in the Hinty panel too (the server was not reached)'}. Nothing was saved.`))
      return 1
    }
    out('')
    if (res.account) out(`  The code was entered by the Hinty account  ${c.b(res.account)}`)
    if (!res.checkHash) return refuse('The server did not send the check number (an older Hinty server?).')
    if (!interactive()) return refuse('Pairing needs a person at this terminal.')
    let matched = false
    for (let i = 1; i <= CHECK_TRIES && !matched; i++) {
      const typed = await ask(`  Type the 4-digit number shown in the Hinty panel: `)
      if (inputClosed && !typed) break
      matched = checkMatches(res.token, res.checkHash, typed)
      if (!matched && i < CHECK_TRIES) out(c.warn(`  That is not the number in the panel (${CHECK_TRIES - i} ${CHECK_TRIES - i === 1 ? 'try' : 'tries'} left).`))
    }
    if (!matched) {
      return refuse('The number did not match the one in the Hinty panel. If you typed the pairing code in your own panel, run `npx hinty-agents` again; if you did not, somebody else may have entered your code.')
    }
    cfg = updateConfig({ api, bridgeToken: res.token, bridgeId: res.bridgeId, label, host: os.hostname(), pairedAt: new Date().toISOString(), entry: cliEntry(), ...(res.account ? { account: res.account } : {}) })
    out(`${c.ok('✓')} Paired. The token is in ${paths().config} (readable by you only).`)
  }

  // asked once: may the Hinty panel / glasses switch away mode ON? (security review point 2; default no)
  if (cfg.remoteAwayOn === undefined) {
    out('')
    out(c.b('Remote switch-on of away mode'))
    for (const l of REMOTE_AWAY_TEXT) out(`  ${l}`)
    const allow = await askYes('Allow switching away mode ON remotely? [y/N] ')
    cfg = updateConfig({ remoteAwayOn: allow, remoteAwayAt: allow ? Date.now() : undefined })
    out(allow ? `${c.ok('✓')} Remote switch-on allowed.` : `${c.ok('✓')} Remote switch-on NOT allowed: only this computer switches away mode on.`)
  }

  if (!noInstall) {
    if (!cc.found) out(`${c.warn('!')} Skipping the Claude Code plugin (Claude Code not found). Later: npx hinty-agents install claude`)
    else await installCmd('claude')
  }

  for (const other of ['codex', 'grok', 'openclaw', 'hermes']) {
    const a = getAdapter(other)
    const f = a && a.detect()
    if (f && f.found && !a.installed().installed) {
      out(`${c.ok('✓')} ${NAMES[other]} ${f.version || ''} found. To follow it too: npx hinty-agents install ${other}`)
    }
  }

  if (!noStart) {
    const s = await startDaemon()
    if (s) out(`${c.ok('✓')} Service running (pid ${s.pid}), link ${s.relay.connected ? 'connected' : 'connecting...'}`)
    else out(c.bad(`✗ The service did not start. See ${paths().log}`))
  }

  out('')
  out(c.b('Away mode is OFF: nothing about your sessions leaves this computer.'))
  out(`When you leave the desk:  npx hinty-agents away on${cfg.remoteAwayOn === true ? '   (or switch it on in the Hinty panel)' : ''}`)
  out('It turns itself off after 12 hours. Back at the desk:  npx hinty-agents away off')
  out('New Claude Code sessions pick the plugin up; restart the ones already open.')
  return 0
}

// ------------------------------------------------------------------------------------------------
// Commands
// ------------------------------------------------------------------------------------------------

async function showStatus() {
  const cfg = readConfig()
  out(c.b(`Hinty Agents ${VERSION}`))
  if (!isPaired(cfg) || !cfg) { out('Paired:   no (run: npx hinty-agents)'); return 0 }
  out(`Paired:   yes, "${oneLine(cfg.label || '?', 60)}" on ${cfg.api}${cfg.account ? `, account ${oneLine(cfg.account, 60)}` : ''}`)
  out(`Remote:   switching away mode ON from the panel/glasses is ${cfg.remoteAwayOn === true ? c.warn('allowed') : 'not allowed'} (npx hinty-agents remote-away on|off)`)
  const s = await daemonStatus()
  if (!s) {
    const old = olderServicePid()
    if (old) out(`Service:  ${c.warn(`an older version is running (pid ${old})`)}: npx hinty-agents stop && npx hinty-agents start`)
    else out(`Service:  ${c.warn('not running')} (start: npx hinty-agents start)`)
    return 0
  }
  out(`Service:  running, pid ${s.pid}, since ${new Date(s.startedAt).toLocaleString()}`)
  out(`Link:     ${s.relay.connected ? c.ok('connected') : c.warn(`not connected${s.relay.lastError ? ` (${oneLine(s.relay.lastError, 60)})` : ''}`)}`)
  out(`Away:     ${awayLine(s.away)}`)
  if (s.away.remoteRefusedAt) {
    const why = s.away.remoteRefusedWhy === 'expired'
      ? 'more than 12 h since you last switched it on or allowed it here; `away on` or `remote-away on` here opens it again'
      : 'not allowed on this computer'
    out(`          ${c.warn(`a remote switch-on was refused at ${hhmm(s.away.remoteRefusedAt)} (${why})`)}`)
  }
  if (cfg.remoteAwayOn === true && !s.away.on) {
    out(`          ${s.away.remoteEnd > Date.now() ? `a remote switch-on is possible until ${new Date(s.away.remoteEnd).toLocaleString()}` : 'a remote switch-on is refused now (more than 12 h since you were last here)'}`)
  }
  out(`Waiting:  ${s.perms} permission request(s)`)
  if (s.voice) out(`Voice:    ${s.voice.ready ? c.ok('ready') : 'not installed (npx hinty-agents voice install)'}`)
  out(`Sessions: ${s.sessions.length ? '' : 'none'}`)
  for (const x of s.sessions) {
    const via = x.agent !== 'claude' ? 'hooks' : x.mod ? 'mod ok' : c.warn('no mod contact')
    out(`  ${oneLine(x.label, 24).padEnd(24)} ${oneLine(x.agent, 10).padEnd(7)} ${oneLine(x.st, 5).padEnd(5)} ${via}`)
  }
  return 0
}

/** @param {{ on: boolean, until: number, since?: number, by?: string }} a */
function awayLine(a) {
  if (!a.on) return 'off (nothing leaves this computer)'
  const remote = a.by === 'remote' && a.since ? c.warn(` - switched on REMOTELY at ${hhmm(a.since)} (panel or glasses). Not you? npx hinty-agents away off`) : ''
  return c.ok(`ON until ${new Date(a.until).toLocaleTimeString()}`) + remote
}

/** HINTY_AGENTS_API (another server than Hinty's): warned, and plain http only to this computer (security review point 8). */
function checkApi(/** @type {string} */ api) {
  if (api === DEFAULT_API) return true
  let u
  try { u = new URL(api) } catch { out(c.bad(`✗ HINTY_AGENTS_API is not a URL: ${oneLine(api, 80)}`)); return false }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) {
    out(c.bad(`✗ ${oneLine(api, 80)}: only https (or http to this computer) is accepted`))
    return false
  }
  out(c.warn(`! Pairing with a server other than Hinty's: ${oneLine(api, 80)} (HINTY_AGENTS_API). Continue only if you set it yourself.`))
  return true
}

/** @param {string | undefined} arg */
async function remoteAwayCmd(arg) {
  if (arg !== 'on' && arg !== 'off') {
    const cfg = readConfig()
    out(`Remote switch-on of away mode: ${cfg?.remoteAwayOn === true ? 'allowed' : 'not allowed'}`)
    out('Usage: npx hinty-agents remote-away on|off')
    return arg === undefined ? 0 : 1
  }
  if (!readConfig()) { out('Not paired yet. Run: npx hinty-agents'); return 1 }
  // the consent time bounds a remote switch-on: at most 12 h after it (or after the last local `away on`)
  updateConfig({ remoteAwayOn: arg === 'on', remoteAwayAt: arg === 'on' ? Date.now() : undefined })
  await tellAgents() // a running service says `hello` again with the new `remoteAway`
  if (arg === 'on') {
    for (const l of REMOTE_AWAY_TEXT) out(l)
    out(`\n${c.ok('✓')} Remote switch-on ALLOWED. Undo: npx hinty-agents remote-away off`)
  } else {
    out(`${c.ok('✓')} Remote switch-on not allowed: only this computer switches away mode on (switching it off remotely still works).`)
    const s = await daemonStatus()
    if (s && s.away.on && s.away.by === 'remote') out(c.warn('! Away mode is ON now (switched on remotely). To switch it off: npx hinty-agents away off'))
  }
  return 0
}

/** @param {string[]} args */
async function voice(args) {
  const [sub, ...rest] = args
  const mi = rest.indexOf('--model')
  const model = mi >= 0 ? rest[mi + 1] : undefined
  if (sub === 'install') {
    try {
      await installVoice({ model, out })
    } catch (e) {
      out(c.bad(`Voice install failed: ${/** @type {Error} */ (e).message}`))
      return 1
    }
    await tellService()
    return 0
  }
  if (sub === 'status') {
    const v = voiceStatus()
    out(c.b('Voice (local speech to text)'))
    out(`Ready:    ${v.ready ? c.ok('yes') : c.warn('no')}${v.model ? ` (model ${v.model})` : ''}`)
    out(`Engine:   ${v.sherpa ? `sherpa-onnx-node ${v.sherpa} (${fmtMB(v.sherpaOnDisk)} on disk)` : 'not installed'}`)
    for (const m of v.models) out(`  ${m.id.padEnd(14)} ${m.installed ? c.ok('installed') : 'not installed'}  ${m.installed ? fmtMB(m.sizeOnDisk) + ' on disk' : 'download ' + fmtMB(m.download)}`)
    if (!v.ready) out(`Install:  npx hinty-agents voice install   (models: ${Object.keys(MODELS).filter((k) => MODELS[k].kind !== 'vad').join(', ')})`)
    return 0
  }
  if (sub === 'remove') {
    const freed = removeVoice()
    out(`${c.ok('✓')} Voice removed (${fmtMB(freed)} freed).`)
    await tellService()
    return 0
  }
  out('Usage: npx hinty-agents voice install [--model parakeet-v3|whisper-small|whisper-turbo] | status | remove')
  return 1
}

/** After installing or removing the voice: a running service says `hello` again (with or without `stt`). */
async function tellService() {
  if (!readDaemonInfo()) return
  try {
    const r = await call('POST', '/v1/voice/reload')
    out(`${c.ok('✓')} The running service was told (speech ${r && r.stt ? 'on' : 'off'}).`)
  } catch {
    out(c.warn('The service did not answer; restart it: npx hinty-agents stop && npx hinty-agents start'))
  }
}

/** @param {string | undefined} arg */
async function away(arg) {
  if (arg !== 'on' && arg !== 'off') { out('Usage: npx hinty-agents away on|off'); return 1 }
  const on = arg === 'on'
  const cfg = readConfig()
  if (!isPaired(cfg)) { out('Not paired yet. Run: npx hinty-agents'); return 1 }
  if (!(await daemonStatus())) {
    if (!on) { out('Away mode is off (the service is not running).'); return 0 }
    if (!(await startDaemon())) { out(c.bad(`The service did not start. See ${paths().log}`)); return 1 }
  }
  const r = await call('POST', '/v1/away', { on })
  if (r.away) {
    out(`${c.ok('✓')} Away mode ON until ${new Date(r.until).toLocaleTimeString()}. Permission prompts and session status go to your Hinty glasses and panel.`)
    const s = await daemonStatus()
    if (s && !s.relay.connected) out(c.warn('! Not connected to Hinty right now: prompts stay in the terminal until the link is back.'))
  } else {
    out(`${c.ok('✓')} Away mode off. Nothing leaves this computer.`)
  }
  return 0
}

/** After install / uninstall: a running service says `hello` again with the new list of agents. */
async function tellAgents() {
  if (!readDaemonInfo()) return
  try { await call('POST', '/v1/agents/reload') } catch { /* the service did not answer: it reads the files at its next start */ }
}

/** @param {string | undefined} agent @param {string[]} [flags] */
async function installCmd(agent, flags = []) {
  const a = getAdapter(agent)
  if (!a) { out(`Usage: npx hinty-agents install <${Object.keys(ADAPTERS).join('|')}>`); return 1 }
  if (agent === 'claude') {
    const cc = claude.detect()
    if (!cc.found) { out(c.bad('✗ Claude Code (`claude`) not found.')); return 1 }
    out(`Installing the Claude Code plugin from ${claude.repoRoot()} ...`)
    const r = claude.install()
    for (const s of r.steps) out(`  ${s.ok ? c.ok('✓') : c.bad('✗')} ${s.step}: ${s.message}`)
    if (r.ok) {
      updateConfig({ entry: cliEntry() })
      out(`${c.ok('✓')} Plugin installed (user scope). New sessions load it; in open ones run /reload-plugins or restart.`)
    }
    return r.ok ? 0 : 1
  }
  const name = NAMES[/** @type {string} */ (agent)]
  const found = a.detect()
  const hooksOnly = agent === 'codex' || agent === 'grok'
  if (!found.found) out(c.warn(`! ${name} was not found on PATH${hooksOnly ? '; installing the hooks anyway (they are only files)' : ''}.`))
  else out(`${c.ok('✓')} ${name} ${found.version || ''}`)
  const askShell = agent === 'grok' && flags.includes('--ask-shell')
  if (agent === 'grok' && askShell) {
    out(c.warn('! --ask-shell: Grok FAILS OPEN. If the Hinty hook crashes, times out or the service is down, Grok RUNS the step.'))
    out(c.warn("  \"Allow\" on the glasses only means \"no veto\": Grok's own permission prompts still apply."))
  }
  const flagValue = (/** @type {string} */ f) => { const i = flags.indexOf(f); return i >= 0 ? flags[i + 1] : undefined }
  const r = await a.install({ askShell, tokenFile: flagValue('--token-file'), url: flagValue('--url') })
  for (const s of r.steps) out(`  ${s.ok ? c.ok('✓') : c.bad('✗')} ${s.step}: ${s.message}`)
  if (r.ok) {
    updateConfig({ entry: cliEntry() })
    await tellAgents()
    out(`${c.ok('✓')} ${name} ${hooksOnly ? 'hooks installed. New sessions pick them up.' : 'connected to the bridge.'}`)
  }
  return r.ok ? 0 : 1
}

/** @param {string | undefined} agent */
async function uninstallCmd(agent) {
  const a = getAdapter(agent)
  if (!a) { out(`Usage: npx hinty-agents uninstall <${Object.keys(ADAPTERS).join('|')}>`); return 1 }
  const r = await a.uninstall()
  for (const s of r.steps) out(`  ${s.ok ? c.ok('✓') : c.bad('✗')} ${s.step}: ${s.message}`)
  if (r.ok && agent !== 'claude') await tellAgents()
  return r.ok ? 0 : 1
}

async function unpair() {
  const cfg = readConfig()
  if (!isPaired(cfg) || !cfg) { out('This computer is not paired.'); return 0 }
  const info = readDaemonInfo()
  let told = false
  if (info && (await daemonStatus())) {
    try { await call('POST', '/v1/unpair'); told = true } catch { /* fall through */ }
    for (let i = 0; i < 30 && pidAlive(info.pid); i++) await sleep(100)
  } else {
    // the service is not running: open the link once, say `unpair`, close
    told = /** @type {boolean} */ (await tellServerUnpair(cfg.api, /** @type {string} */ (cfg.bridgeToken)))
  }
  updateConfig({ bridgeToken: undefined, bridgeId: undefined, account: undefined })
  out(told ? `${c.ok('✓')} Unpaired. The token is deleted.` : `${c.warn('!')} The token is deleted here, but the server was not reached: remove the computer in the Hinty panel too.`)
  return 0
}

async function doctor() {
  let bad = 0
  /** @param {boolean | null} ok @param {string} text @param {string} [hint] */
  const line = (ok, text, hint) => {
    if (ok === false) bad++
    out(`${ok === true ? c.ok('✓') : ok === false ? c.bad('✗') : c.warn('!')} ${text}${hint ? c.dim(`  -> ${hint}`) : ''}`)
  }
  out(c.b(`Hinty Agents ${VERSION} doctor`))
  line(Number(process.versions.node.split('.')[0]) >= 20, `Node.js ${process.versions.node}`)
  const cfg = readConfig()
  line(isPaired(cfg), isPaired(cfg) ? `Paired with ${cfg?.api} as "${oneLine(cfg?.label, 60)}"${cfg?.account ? `, account ${oneLine(cfg.account, 60)}` : ''}` : 'Not paired', 'npx hinty-agents')
  line(null, `Remote switch-on of away mode ${cfg?.remoteAwayOn === true ? 'ALLOWED' : 'not allowed'}`, 'npx hinty-agents remote-away on|off')
  // the data folder holds the bridge token and the service's key: only you (and SYSTEM) may open it (review 2, Z7)
  const acc = homeAccess()
  if (acc.checked) {
    line(acc.ok, acc.ok ? `Data folder ${homeDir()} is open to you only` : `Data folder ${homeDir()}: ${acc.problem}`,
      acc.ok ? undefined : process.platform === 'win32' ? 'move it into your user profile (unset HINTY_AGENTS_HOME) or fix its access in Properties -> Security' : `chmod 700 "${homeDir()}" (and make sure you own it)`)
  }

  const cc = claude.detect()
  line(cc.found, cc.found ? `Claude Code ${cc.version}` : 'Claude Code not found')
  if (cc.found) {
    const inst = claude.installed()
    line(inst.installed && inst.enabled, inst.installed ? `Plugin ${claude.PLUGIN_ID} ${inst.version || ''} ${inst.enabled ? 'enabled' : 'DISABLED'}${inst.folder ? ` (${inst.folder})` : ''}` : 'Plugin not installed', inst.installed ? undefined : 'npx hinty-agents install claude')
    // the plugin and this service must speak the same local protocol; an older plugin stays silent
    if (inst.installed && inst.version && inst.version !== VERSION) line(false, `Plugin ${inst.version} is not this version (${VERSION}): its hooks stay silent`, 'npx hinty-agents install claude')
    const v = claude.validate(inst.folder && fs.existsSync(inst.folder) ? inst.folder : claude.pluginDir())
    line(v.ok, v.ok ? 'Plugin and mod pass `claude plugin validate`' : `Plugin does not validate: ${v.errors.slice(0, 2).join('; ')}`)
  }

  for (const other of ['codex', 'grok']) {
    const a = getAdapter(other)
    const name = NAMES[other]
    const f = a.detect()
    const inst = a.installed()
    if (!f.found && !inst.installed) continue
    line(null, f.found ? `${name} ${f.version || ''}` : `${name} not found on PATH`)
    if (other === 'codex') {
      line(inst.installed ? inst.complete : null, inst.installed ? `Codex hooks: ${inst.events.length} of 6 in ${inst.file}` : 'Codex hooks not installed',
        inst.installed ? (inst.complete ? 'trusted? open Codex and type /hooks (Codex skips untrusted hooks)' : 'npx hinty-agents install codex') : 'npx hinty-agents install codex')
      for (const n of a.configNotes()) line(null, n)
    } else {
      line(inst.installed ? true : null, inst.installed ? `Grok hooks in ${inst.file}${inst.askShell ? ' (ask-shell ON: Grok fails open)' : ''}` : 'Grok hooks not installed', inst.installed ? undefined : 'npx hinty-agents install grok')
    }
    // the hooks start Node by full path (review 2, Z3); after a Node.js update or removal that path may be gone
    if (inst.installed && inst.node) {
      const n = inst.node
      if (n.byName) line(false, `${name} hooks start \`node\` by name (on Windows a node.cmd in the project folder would run instead)`, `npx hinty-agents install ${other}`)
      else line(n.ok, n.ok ? `${name} hooks start Node.js at ${n.node}` : `${name} hooks start a Node.js that is gone: ${n.node}`,
        n.ok ? undefined : `npx hinty-agents install ${other}${other === 'codex' ? ' (Codex then asks you to trust the hooks again)' : ''}`)
    }
  }
  for (const other of ['openclaw', 'hermes']) {
    const a = getAdapter(other)
    const f = a.detect()
    if (!f.found && !a.installed().installed) continue
    line(null, f.found ? `${NAMES[other]} ${f.version || ''}` : `${NAMES[other]} not found on PATH`)
    for (const l of await a.doctor()) line(l.ok, l.text, l.hint)
  }

  const s = await daemonStatus()
  const old = s ? 0 : olderServicePid()
  line(!!s, s ? `Service running (pid ${s.pid})` : old ? `An older version of the service is running (pid ${old})` : 'Service not running', s ? undefined : old ? 'npx hinty-agents stop && npx hinty-agents start' : 'npx hinty-agents start')
  if (s) {
    line(s.relay.connected, s.relay.connected ? 'Link to Hinty connected' : `Link to Hinty down${s.relay.lastError ? ` (${oneLine(s.relay.lastError, 60)})` : ''}`)
    line(null, `Away mode ${awayLine(s.away)}`)
    const hook = spawnSync(process.execPath, [`${claude.pluginDir()}/hook.cjs`, 'Doctor'], { encoding: 'utf8', timeout: 10000, env: childEnv(), windowsHide: true, cwd: os.homedir() })
    let h = null
    try { h = JSON.parse(hook.stdout) } catch { /* no answer */ }
    line(!!(h && h.ok), h && h.ok ? `Hook reaches the service (${h.ms} ms)` : 'Hook cannot reach the service')
    const claudeSessions = s.sessions.filter((/** @type {any} */ x) => x.agent === 'claude')
    const withMod = claudeSessions.filter((/** @type {any} */ x) => x.mod)
    const noMod = claudeSessions.filter((/** @type {any} */ x) => !x.mod)
    if (!claudeSessions.length) line(null, 'No Claude Code session seen yet (open one to check the mod)')
    else line(noMod.length ? null : true, `Mod active in ${withMod.length} of ${claudeSessions.length} session(s)`,
      noMod.length ? 'sessions without the mod: mods may be off (disableAllHooks / allowManagedModsOnly) or the session predates the plugin' : undefined)
  }
  out(bad ? c.bad(`\n${bad} problem(s).`) : c.ok('\nAll good.'))
  return bad ? 1 : 0
}
