// @ts-check
// The background service (one per computer): relay connection + local HTTP port for the hook and the mod.
// Started by `hinty-agents start` (or the wizard, or the SessionStart hook after a reboot); stopped by `hinty-agents stop`.
import fs from 'node:fs'
import path from 'node:path'
import { checkRunningCopy } from './app.js'
import { newSecret } from './crypto.js'
import { pingOwn } from './client.js'
import { hardenEnv } from './exec.js'
import { daemonRecord } from './localauth.js'
import { systemNotify } from './notify.js'
import { SCRIPTS, hooksDir, sourceDir } from './adapters/hookfiles.js'
import { activeAgents } from './adapters/index.js'
import * as codex from './adapters/codex.js'
import * as grok from './adapters/grok.js'
import { OpenClawLink } from './adapters/openclaw.js'
import { HermesLink, pluginDir as hermesPluginDir, pluginSource as hermesPluginSource } from './adapters/hermes.js'
import { createLocalServer, listenLoopback } from './local-http.js'
import { createLog } from './log.js'
import { Relay } from './relay.js'
import { Service } from './service.js'
import { voiceReady } from './stt/install.js'
import { SherpaEngine } from './stt/sherpa.js'
import { ensureHome, homeAccess, isPaired, paths, pidAlive, readConfig, readDaemonInfo, readJson, updateConfig, writeJson } from './store.js'
import { VERSION } from './version.js'

/**
 * Is this live pid our service? Only a signed /v1/ping answering with the same pid says so (security review point 7,
 * review 2 Z13: a command line that merely looks like `hinty-agents.js daemon` does not count any more).
 * @param {number} pid
 */
export async function isOurService(pid) {
  const info = readDaemonInfo()
  return !!info && info.pid === pid && await pingOwn(info)
}

/** How long a lock held by a live process that does not answer yet is respected (a service that is still starting). */
export const LOCK_STARTUP_MS = 3000

/**
 * Single instance per computer: an exclusive lock file with our pid. A lock of a live process counts only once that
 * process answers a signed ping; a process that holds the lock but never answers (a dead run's pid now used by another
 * program, or something that looks like us) is waited for at most LOCK_STARTUP_MS, then the lock is taken over (logged).
 * @param {(m: string, f?: Record<string, any>) => void} log
 */
async function takeLock(log) {
  const { lock } = paths()
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
      return true
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'EEXIST') throw e
      let other = 0
      try { other = Number(fs.readFileSync(lock, 'utf8').trim()) } catch { /* raced */ }
      if (other && other !== process.pid && pidAlive(other)) {
        const t0 = Date.now()
        while (pidAlive(other)) {
          if (await isOurService(other)) return false
          if (Date.now() - t0 >= LOCK_STARTUP_MS) break
          await new Promise((r) => setTimeout(r, 250))
        }
        log('lock_stale', { pid: other, why: 'not_our_service' })
      }
      try { fs.unlinkSync(lock) } catch { /* raced */ }
    }
  }
  return false
}

/**
 * The hook scripts the agents run (~/.hinty-agents/hooks) and the Hermes plugin are copies; after an update of this
 * package they would speak the old local protocol and stay silent. When present, they are refreshed at start.
 * @param {(m: string, f?: Record<string, any>) => void} log
 */
function refreshCopies(log) {
  try {
    const dest = hooksDir()
    if (fs.existsSync(path.join(dest, 'common.cjs'))) {
      let n = 0
      for (const f of SCRIPTS) {
        const src = fs.readFileSync(path.join(sourceDir(), f))
        const to = path.join(dest, f)
        let cur = null
        try { cur = fs.readFileSync(to) } catch { /* missing */ }
        if (!cur || !cur.equals(src)) { fs.writeFileSync(`${to}.tmp`, src); fs.renameSync(`${to}.tmp`, to); n++ }
      }
      if (n) log('hooks_refreshed', { n })
    }
  } catch (e) { log('hooks_refresh_failed', { err: /** @type {Error} */ (e)?.name }) }
  try { if (hermesRefresh()) log('hermes_plugin_refreshed') } catch (e) { log('hermes_refresh_failed', { err: /** @type {Error} */ (e)?.name }) }
}

/** @returns {boolean} the installed Hermes plugin copy was older and got replaced */
function hermesRefresh() {
  const dst = hermesPluginDir()
  const own = path.join(hermesPluginSource(), '__init__.py')
  const cur = path.join(dst, '__init__.py')
  if (!fs.existsSync(cur) || !fs.readFileSync(cur, 'utf8').includes('hinty-agents-marker')) return false
  let changed = false
  for (const f of fs.readdirSync(hermesPluginSource(), { withFileTypes: true })) {
    if (!f.isFile()) continue
    const src = fs.readFileSync(path.join(hermesPluginSource(), f.name))
    const to = path.join(dst, f.name)
    let now = null
    try { now = fs.readFileSync(to) } catch { /* missing */ }
    if (!now || !now.equals(src)) { fs.writeFileSync(to, src); changed = true }
  }
  return changed && fs.existsSync(own)
}

export async function runDaemon() {
  hardenEnv()
  ensureHome()
  // never keep the folder the service was started from (it may be somebody's repository) as the current folder
  try { process.chdir(paths().home) } catch { /* stays */ }
  const p = paths()
  const log = createLog(p.log)
  // the folder's access was narrowed and read back by ensureHome(); a failure is kept for `doctor` and logged (Z7)
  if (!homeAccess().ok) log('home_access', { ok: false, problem: homeAccess().problem.slice(0, 80) })
  // started from the program copy (by `start`, or by a hook after a reboot): it must still match the manifest written
  // when it was made; a quick check (files and sizes). Otherwise no service, so every hook stays empty (review 3, 6b; N1)
  const copy = checkRunningCopy({ quick: true })
  if (!copy.ok) {
    log('app_copy_mismatch', { why: copy.why.slice(0, 80) })
    console.error(`hinty-agents: the program copy does not match its manifest (${copy.why}); the service does not start. Copy it again: npx hinty-agents@latest start`)
    process.exitCode = 1
    return
  }
  const config = readConfig()
  if (!isPaired(config) || !config) {
    log('not_paired')
    console.error('hinty-agents: this computer is not paired yet (run: npx hinty-agents)')
    process.exitCode = 1
    return
  }
  if (!(await takeLock(log))) {
    console.error('hinty-agents: the service is already running')
    return
  }
  // a daemon.json left by a service that died (reboot, kill): gone before we listen (security review point 1)
  try { fs.unlinkSync(p.daemon) } catch { /* none */ }
  refreshCopies(log)
  const key = newSecret()
  const relay = new Relay({ api: config.api, token: /** @type {string} */ (config.bridgeToken), log })
  let stopping = false

  const engine = new SherpaEngine({ log })
  const service = new Service({
    voice: { engine, ready: voiceReady },
    agents: () => ({ agents: activeAgents(), grok: { askShell: grok.askShellOn(), except: grok.exceptions() } }),
    relay: { get connected() { return relay.connected }, emit: (ev, payload) => relay.send(ev, payload) },
    log,
    // the person's consent, given at this computer, read again at every remote request (security review point 2)
    remoteAwayAllowed: () => readConfig()?.remoteAwayOn === true,
    // when that consent was given: a remote switch-on lasts at most 12 h from it or from the last local `away on` (Z9)
    remoteAwaySince: () => Number(readConfig()?.remoteAwayAt) || 0,
    onRemoteAway: (at) => {
      if (readConfig()?.notify === false || process.env.HINTY_AGENTS_NO_NOTIFY === '1') return
      log('notify', { kind: 'remote_away', started: systemNotify('remote_away', at) })
    },
    onUnpaired: (why) => {
      log('unpaired', { why })
      updateConfig({ bridgeToken: undefined, bridgeId: undefined })
      void shutdown(0)
    },
  })
  relay.on('relay', (ev, payload) => service.onRelay(ev, payload))
  // E5: OpenClaw (own WebSocket to its Gateway, only while live) and Hermes (its plugin calls our local port)
  const openclaw = new OpenClawLink({ service, log })
  service.attachAgent('openclaw', { say: (sid, text) => openclaw.say(sid, text) })
  const hermes = new HermesLink({ service, log })
  service.onLive((live) => {
    if (live) openclaw.start()
    else { openclaw.stop(); hermes.clear() }
  })
  // instructions for Codex sessions go through `codex queue` when this Codex has it; `"codex": {"queue": false}` in
  // config.json (or HINTY_AGENTS_CODEX_SAY=hold, for tests) keeps them on the held Stop hook instead: `codex queue` gets
  // the text as a command-line argument, which other users of a shared Linux / macOS computer can see in the process
  // list for a moment. The probe runs in the background and never delays start.
  if (process.env.HINTY_AGENTS_CODEX_SAY !== 'hold' && config.codex?.queue !== false) {
    setImmediate(() => {
      try { if (codex.queueSupported()) { service.codexQueue = codex.queueMessage; log('codex_queue', { ok: true }) } else log('codex_queue', { ok: false }) } catch { log('codex_queue', { ok: false }) }
    })
  }

  const server = createLocalServer({
    key,
    log,
    routes: {
      'GET /v1/ping': () => ({ ok: true, v: 2, pid: process.pid, version: VERSION }),
      'GET /v1/status': () => ({ ...service.status(), version: VERSION, api: config.api, label: config.label || null, bridgeId: config.bridgeId || null }),
      'POST /v1/hook/permission': (body, ctl) => service.hookPermission(body, ctl),
      'POST /v1/hook/session-start': (body) => service.hookSessionStart(body),
      // Codex CLI and Grok Build hooks (E4)
      'POST /v1/hook/codex/permission': (body, ctl) => service.codexPermission(body, ctl),
      'POST /v1/hook/codex/stop': (body, ctl) => service.codexStop(body, ctl),
      'POST /v1/hook/codex/session-start': (body) => service.agentSessionStart('codex', body),
      'POST /v1/hook/codex/prompt': (body) => service.agentActivity('codex', body),
      'POST /v1/hook/codex/tool': (body) => service.agentActivity('codex', body),
      'POST /v1/hook/codex/session-end': (body) => service.agentSessionEnd('codex', body),
      'POST /v1/hook/grok/pre-tool': (body, ctl) => service.grokPreTool(body, ctl),
      'POST /v1/hook/grok/stop': (body) => service.agentStop('grok', body),
      'POST /v1/hook/grok/session-start': (body) => service.agentSessionStart('grok', body),
      'POST /v1/hook/grok/prompt': (body) => service.agentActivity('grok', body),
      'POST /v1/hook/grok/session-end': (body) => service.agentSessionEnd('grok', body),
      // Hermes Agent plugin (E5)
      'POST /v1/hermes/perm': (body, ctl) => hermes.perm(body, ctl),
      'POST /v1/hermes/event': (body) => hermes.event(body),
      'POST /v1/hermes/poll': (body, ctl) => hermes.poll(body, ctl),
      'POST /v1/hermes/ack': (body) => hermes.ack(body),
      // after `install` / `uninstall` of an agent: say `hello` again with the new list
      'POST /v1/agents/reload': () => service.agentsChanged(),
      'POST /v1/mod/poll': (body, ctl) => service.modPoll(body, ctl),
      'POST /v1/mod/event': (body) => service.modEvent(body),
      'POST /v1/mod/ack': (body) => service.modAck(body),
      'POST /v1/away': (body) => (body && typeof body.on === 'boolean' ? service.setAway(body.on, 'cli') : { error: 'invalid' }),
      // after `voice install` / `voice remove`: drop the loaded model and say `hello` again (with or without `stt`)
      'POST /v1/voice/reload': () => { engine.release(); return service.voiceChanged() },
      'POST /v1/stop': () => { setTimeout(() => void shutdown(0), 50); return { ok: true } },
      'POST /v1/unpair': () => {
        relay.send('unpair')
        updateConfig({ bridgeToken: undefined, bridgeId: undefined })
        setTimeout(() => void shutdown(0), 500)
        return { ok: true }
      },
    },
  })
  const port = await listenLoopback(server)
  writeJson(p.daemon, daemonRecord({ pid: process.pid, port, key, version: VERSION }))
  log('start', { pid: process.pid, port, v: VERSION })

  const ticker = setInterval(() => service.tick(), 5000)
  relay.start()

  /** @param {number} code */
  async function shutdown(code) {
    if (stopping) return
    stopping = true
    log('stop', { code })
    clearInterval(ticker)
    service.stop()
    openclaw.stop()
    engine.release()
    relay.stop()
    server.close()
    server.closeAllConnections?.()
    const d = readJson(p.daemon)
    if (d && d.pid === process.pid) { try { fs.unlinkSync(p.daemon) } catch { /* gone */ } }
    try { if (Number(fs.readFileSync(p.lock, 'utf8')) === process.pid) fs.unlinkSync(p.lock) } catch { /* gone */ }
    setTimeout(() => process.exit(code), 100).unref()
  }

  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))
  process.on('SIGHUP', () => void shutdown(0))
  process.on('uncaughtException', (e) => { log('crash', { err: e?.name || 'error' }); void shutdown(1) })
  process.on('unhandledRejection', (e) => { log('crash', { err: /** @type {any} */ (e)?.name || 'rejection' }); void shutdown(1) })
}
