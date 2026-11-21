// @ts-check
// Command line: setup wizard, status, away mode, plugin install, doctor, unpair, start/stop.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { call, status as daemonStatus } from './client.js'
import * as claude from './adapters/claude.js'
import { ADAPTERS, get as getAdapter } from './adapters/index.js'
import { prettyCode, pair } from './pair.js'
import { Relay } from './relay.js'
import { DEFAULT_API, cliEntry, ensureHome, isPaired, paths, pidAlive, readConfig, readDaemonInfo, updateConfig } from './store.js'
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
  const [cmd, ...rest] = argv
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
  if (process.env.HINTY_AGENTS_WEB) return process.env.HINTY_AGENTS_WEB
  return api === DEFAULT_API ? 'https://www.hinty.eu/dashboard/voice-assistant/agents' : null
}

// ------------------------------------------------------------------------------------------------
// Service lifecycle
// ------------------------------------------------------------------------------------------------

/** @returns {Promise<any | null>} status of the running (or just started) service */
export async function startDaemon() {
  updateConfig({ stopped: false, entry: cliEntry() })
  const now = await daemonStatus()
  if (now) return now
  const child = spawn(process.execPath, [cliEntry(), 'daemon'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env })
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
  const s = await startDaemon()
  if (!s) { out(c.bad('The service did not start. See ' + paths().log)); return 1 }
  out(`${c.ok('✓')} Service running (pid ${s.pid}).`)
  return 0
}

async function stop() {
  if (readConfig()) updateConfig({ stopped: true })
  const info = readDaemonInfo()
  if (!info) { out('The service is not running.'); return 0 }
  try { await call('POST', '/v1/stop') } catch { /* not answering */ }
  for (let i = 0; i < 40 && pidAlive(info.pid); i++) await sleep(100)
  if (pidAlive(info.pid)) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(info.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else { try { process.kill(info.pid, 'SIGTERM') } catch { /* gone */ } }
    await sleep(300)
  }
  for (const f of [paths().daemon, paths().lock]) { try { if (!pidAlive(info.pid)) fs.unlinkSync(f) } catch { /* gone */ } }
  out(pidAlive(info.pid) ? c.bad(`The service (pid ${info.pid}) is still running.`) : `${c.ok('✓')} Service stopped. It will not start again until \`npx hinty-agents start\`.`)
  return pidAlive(info.pid) ? 1 : 0
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
    out(`${c.ok('✓')} Already paired with ${cfg.api} as "${cfg.label || '?'}" (to pair again: npx hinty-agents unpair)`)
  } else {
    const api = apiFor(null)
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
    cfg = updateConfig({ api, bridgeToken: res.token, bridgeId: res.bridgeId, label, host: os.hostname(), pairedAt: new Date().toISOString(), entry: cliEntry() })
    out(`${c.ok('✓')} Paired. The token is in ${paths().config} (readable by you only).`)
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
  out('When you leave the desk:  npx hinty-agents away on   (or switch it on in the Hinty panel)')
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
  out(`Paired:   yes, "${cfg.label || '?'}" on ${cfg.api}`)
  const s = await daemonStatus()
  if (!s) { out(`Service:  ${c.warn('not running')} (start: npx hinty-agents start)`); return 0 }
  out(`Service:  running, pid ${s.pid}, since ${new Date(s.startedAt).toLocaleString()}`)
  out(`Link:     ${s.relay.connected ? c.ok('connected') : c.warn(`not connected${s.relay.lastError ? ` (${s.relay.lastError})` : ''}`)}`)
  out(`Away:     ${s.away.on ? c.ok(`ON until ${new Date(s.away.until).toLocaleTimeString()}`) : 'off (nothing leaves this computer)'}`)
  out(`Waiting:  ${s.perms} permission request(s)`)
  if (s.voice) out(`Voice:    ${s.voice.ready ? c.ok('ready') : 'not installed (npx hinty-agents voice install)'}`)
  out(`Sessions: ${s.sessions.length ? '' : 'none'}`)
  for (const x of s.sessions) {
    const via = x.agent !== 'claude' ? 'hooks' : x.mod ? 'mod ok' : c.warn('no mod contact')
    out(`  ${x.label.padEnd(24)} ${x.agent.padEnd(7)} ${x.st.padEnd(5)} ${via}`)
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
    const relay = new Relay({ api: cfg.api, token: /** @type {string} */ (cfg.bridgeToken) })
    told = await new Promise((resolve) => {
      const t = setTimeout(() => { relay.stop(); resolve(false) }, 8000)
      relay.on('relay', (ev) => {
        if (ev === 'ready') { relay.send('unpair'); setTimeout(() => { clearTimeout(t); relay.stop(); resolve(true) }, 800) }
        if (ev === 'invalid_token') { clearTimeout(t); relay.stop(); resolve(true) }
      })
      relay.start()
    })
  }
  updateConfig({ bridgeToken: undefined, bridgeId: undefined })
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
  line(isPaired(cfg), isPaired(cfg) ? `Paired with ${cfg?.api} as "${cfg?.label}"` : 'Not paired', 'npx hinty-agents')

  const cc = claude.detect()
  line(cc.found, cc.found ? `Claude Code ${cc.version}` : 'Claude Code not found')
  if (cc.found) {
    const inst = claude.installed()
    line(inst.installed && inst.enabled, inst.installed ? `Plugin ${claude.PLUGIN_ID} ${inst.version || ''} ${inst.enabled ? 'enabled' : 'DISABLED'}${inst.folder ? ` (${inst.folder})` : ''}` : 'Plugin not installed', inst.installed ? undefined : 'npx hinty-agents install claude')
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
  }
  for (const other of ['openclaw', 'hermes']) {
    const a = getAdapter(other)
    const f = a.detect()
    if (!f.found && !a.installed().installed) continue
    line(null, f.found ? `${NAMES[other]} ${f.version || ''}` : `${NAMES[other]} not found on PATH`)
    for (const l of await a.doctor()) line(l.ok, l.text, l.hint)
  }

  const s = await daemonStatus()
  line(!!s, s ? `Service running (pid ${s.pid})` : 'Service not running', s ? undefined : 'npx hinty-agents start')
  if (s) {
    line(s.relay.connected, s.relay.connected ? 'Link to Hinty connected' : `Link to Hinty down${s.relay.lastError ? ` (${s.relay.lastError})` : ''}`)
    line(null, `Away mode ${s.away.on ? `ON until ${new Date(s.away.until).toLocaleTimeString()}` : 'off'}`)
    const hook = spawnSync(process.execPath, [`${claude.pluginDir()}/hook.cjs`, 'Doctor'], { encoding: 'utf8', timeout: 10000, env: process.env, windowsHide: true })
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
