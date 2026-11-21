'use strict'
// Hinty Agents desktop app: a small window and an icon next to the clock, over the hinty-agents bridge.
//
// The bridge does all the work, exactly as from a terminal: this process starts `<bundled Node.js> bridge/bin/
// hinty-agents.js desktop` (src/desktop.js in the repository) and passes the window's buttons to it as requests. The
// Electron binary itself never runs bridge code (its RunAsNode fuse is off): the background service, the hooks the
// agents start and npm for the voice engine all run on the bundled Node.js.
//
// The window gets no Node.js and no file access (sandbox, context isolation); preload.cjs exposes a fixed list of calls,
// each checked here again. Nothing from the network is loaded: the window is a local file with a strict CSP.
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, nativeTheme, clipboard, session } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn, spawnSync } = require('child_process')
const I18N = require('./ui/i18n.js')

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

// Tests run the app with its own data folder; people never need this (Chromium's --user-data-dir works too).
const OWN_DATA = process.env.HINTY_DESKTOP_USER_DATA
if (OWN_DATA && path.isAbsolute(OWN_DATA)) {
  app.setPath('userData', OWN_DATA)
  app.setPath('sessionData', path.join(OWN_DATA, 'session'))
}
// a login item is a change to the account (Windows registry, macOS login items): never from a test or a dev run
const LOGIN_ITEMS = app.isPackaged && process.env.HINTY_DESKTOP_NO_LOGIN_ITEM !== '1'

if (IS_WIN) app.setAppUserModelId('eu.hinty.agents')
nativeTheme.themeSource = 'dark'

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(boot)
}

// ------------------------------------------------------------------------------------------------
// Where things are
// ------------------------------------------------------------------------------------------------

const RES = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'build')
const NODE = IS_WIN ? path.join(RES, 'node', 'node.exe') : path.join(RES, 'node', 'bin', 'node')
const BRIDGE = path.join(RES, 'bridge', 'bin', 'hinty-agents.js')
const ICONS = path.join(__dirname, 'ui', 'img')
const SETTINGS = () => path.join(app.getPath('userData'), 'settings.json')

function readSettings() {
  let s = {}
  try { s = JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')) } catch { /* first start */ }
  return {
    openAtLogin: s.openAtLogin !== false,
    lang: typeof s.lang === 'string' && I18N.LANGS.includes(s.lang) ? s.lang : null,
    firstRunDone: s.firstRunDone === true,
  }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(SETTINGS(), JSON.stringify(next, null, 2) + '\n')
  return next
}
const systemLang = () => I18N.pick((app.getPreferredSystemLanguages && app.getPreferredSystemLanguages()[0]) || app.getLocale())
const lang = () => readSettings().lang || systemLang()
const t = (key, vars) => I18N.t(lang(), key, vars)

/** Start at sign-in, in the background (tray only, no window): the service then runs after a reboot too. */
function applyLoginItem(on) {
  if (!LOGIN_ITEMS) return
  if (IS_WIN) app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: ['--hidden'], name: 'Hinty Agents' })
  else app.setLoginItemSettings({ openAtLogin: on })
}
const startedHidden = () => process.argv.includes('--hidden') || (IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin === true)

// ------------------------------------------------------------------------------------------------
// The worker (the bridge on the bundled Node.js)
// ------------------------------------------------------------------------------------------------

/** PATH for the worker. macOS starts apps from Finder with a minimal PATH; the agents live where the login shell finds them. */
function workerPath(current) {
  if (!IS_MAC) return current
  const parts = []
  try {
    const shellExe = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
    const r = spawnSync(shellExe, ['-ilc', 'printf "__HINTY_PATH__%s" "$PATH"'], { encoding: 'utf8', timeout: 5000, cwd: os.homedir() })
    const m = String(r.stdout || '').match(/__HINTY_PATH__(.*)$/m)
    if (m) parts.push(...m[1].split(':'))
  } catch { /* fall back to the usual places */ }
  const home = os.homedir()
  parts.push(...String(current || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin')
  return [...new Set(parts.filter((p) => p && path.isAbsolute(p)))].join(':')
}

let worker = null
let workerUp = false
let quitting = false
let nextId = 0
const pending = new Map()
let workerPathCache = null

function logFile() {
  const f = path.join(app.getPath('userData'), 'worker.log')
  try { if (fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, f + '.1') } catch { /* none yet */ }
  return f
}

function startWorker() {
  if (!fs.existsSync(NODE) || !fs.existsSync(BRIDGE)) {
    sendToWindow('hinty:event', 'fatal', { why: 'missing', node: NODE, bridge: BRIDGE })
    return
  }
  const env = { ...process.env }
  // nothing of Electron's own and no NODE_OPTIONS reaches the bridge (the same as Electron's own fuse for itself)
  for (const k of Object.keys(env)) if (/^ELECTRON_/i.test(k) || /^NODE_OPTIONS$/i.test(k)) delete env[k]
  if (IS_MAC) env.PATH = workerPathCache || (workerPathCache = workerPath(env.PATH))
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  const log = fs.openSync(logFile(), 'a')
  fs.writeSync(log, `\n${new Date().toISOString()} start ${NODE} ${BRIDGE} desktop\n`)
  const child = spawn(NODE, [BRIDGE, 'desktop'], { cwd: os.homedir(), env, stdio: ['ignore', log, log, 'ipc'], windowsHide: true })
  fs.closeSync(log)
  worker = child
  child.on('message', (m) => {
    if (!m || typeof m !== 'object') return
    if (m.t === 'res' && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.ok) p.resolve(m.r)
      else p.reject(new Error(String(m.err || 'error')))
    } else if (m.t === 'ev') {
      if (m.ev === 'ready') { workerUp = true; onWorkerReady() }
      sendToWindow('hinty:event', String(m.ev), m.d)
    }
  })
  child.on('exit', (code) => {
    if (worker === child) { worker = null; workerUp = false }
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('worker_exit')) }
    pending.clear()
    if (!quitting) {
      sendToWindow('hinty:event', 'helper_down', { code })
      setTimeout(() => { if (!quitting && !worker) startWorker() }, 2000)
    }
  })
}

/** one request to the worker @returns {Promise<any>} */
function call(m, p = {}, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    if (!worker || !worker.connected) return reject(new Error('worker_down'))
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')) }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    worker.send({ t: 'req', id, m, p })
  })
}

// ------------------------------------------------------------------------------------------------
// State, tray
// ------------------------------------------------------------------------------------------------

let lastState = null
let tray = null
let win = null
let ensuredService = false

async function poll() {
  if (!workerUp) return
  try {
    lastState = await call('state', {}, 20000)
    sendToWindow('hinty:state', lastState)
    updateTray()
  } catch { /* the next tick tries again */ }
}

async function onWorkerReady() {
  await poll()
  // the background service runs while this computer is paired, unless the person stopped it
  if (!ensuredService && lastState && lastState.paired && !lastState.stopped && !lastState.service && !lastState.older) {
    ensuredService = true
    try { await call('start', {}, 60000) } catch { /* shown in the window */ }
    await poll()
  }
}

function trayIcon(on) {
  if (IS_MAC) {
    const img = nativeImage.createFromPath(path.join(ICONS, on ? 'trayOnTemplate.png' : 'trayTemplate.png'))
    img.setTemplateImage(true)
    return img
  }
  return nativeImage.createFromPath(path.join(ICONS, on ? 'tray-on.png' : 'tray.png'))
}

function updateTray() {
  if (!tray) return
  const s = lastState
  const on = !!(s && s.service && s.service.away && s.service.away.on)
  tray.setImage(trayIcon(on))
  tray.setToolTip(!s || !s.paired ? t('tip_unpaired') : on ? t('tip_on') : t('tip_off'))
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('tray_open'), click: () => showWindow() },
    { type: 'separator' },
    {
      label: t('tray_away'), type: 'checkbox', checked: on, enabled: !!(s && s.paired),
      click: async (item) => { try { await call('away', { on: item.checked }, 60000) } catch { /* window shows it */ } poll() },
    },
    { type: 'separator' },
    { label: t('tray_quit'), click: () => { quitting = true; app.quit() } },
  ]))
}

// ------------------------------------------------------------------------------------------------
// The window
// ------------------------------------------------------------------------------------------------

function sendToWindow(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function createWindow() {
  win = new BrowserWindow({
    width: 460, height: 780, minWidth: 400, minHeight: 540,
    show: false, backgroundColor: '#000000', title: 'Hinty Agents', autoHideMenuBar: true,
    icon: path.join(ICONS, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false,
    },
  })
  if (!IS_MAC) win.setMenu(null)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); if (IS_MAC && app.dock) app.dock.hide() }
  })
  win.loadFile(path.join(__dirname, 'ui', 'index.html'))
  return win
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow()
  if (IS_MAC && app.dock) app.dock.show()
  if (win.webContents.isLoading()) win.once('ready-to-show', () => { win.show(); win.focus() })
  else { win.show(); win.focus() }
}

// ------------------------------------------------------------------------------------------------
// Calls from the window (preload.cjs), checked again here
// ------------------------------------------------------------------------------------------------

/** worker requests the window may make, and the fields each may carry (anything else is dropped) */
const ALLOWED = {
  state: [], agents: [], voiceStatus: [],
  pairStart: [], pairCheck: ['digits'], pairCancel: [],
  away: ['on'], remoteAway: ['on'],
  install: ['agent', 'askShell'], uninstall: ['agent'],
  voiceInstall: [], voiceRemove: [],
  start: [], stop: [], unpair: [], uninstallAll: ['purge'],
}
const AGENTS = ['claude', 'codex', 'grok', 'openclaw', 'hermes']

function cleanParams(method, p) {
  const out = {}
  const src = p && typeof p === 'object' ? p : {}
  for (const k of ALLOWED[method]) {
    const v = src[k]
    if (k === 'digits' && typeof v === 'string') out.digits = v.slice(0, 16)
    else if (k === 'agent' && AGENTS.includes(v)) out.agent = v
    else if ((k === 'on' || k === 'askShell' || k === 'purge') && typeof v === 'boolean') out[k] = v
  }
  return out
}

function setupIpc() {
  ipcMain.handle('hinty:call', async (e, method, params) => {
    if (!win || e.sender !== win.webContents) throw new Error('not_allowed')
    if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(ALLOWED, method)) throw new Error('unknown_method')
    const r = await call(method, cleanParams(method, params))
    if (['away', 'remoteAway', 'start', 'stop', 'unpair', 'uninstallAll', 'pairCancel'].includes(method)) setTimeout(poll, 300)
    if (method === 'uninstallAll' && r && r.code === 0) { writeSettings({ openAtLogin: false }); applyLoginItem(false) }
    return r
  })
  ipcMain.handle('hinty:app', async (e, action, arg) => {
    if (!win || e.sender !== win.webContents) throw new Error('not_allowed')
    switch (action) {
      case 'info': {
        const s = readSettings()
        return { openAtLogin: s.openAtLogin, lang: s.lang, systemLang: systemLang(), langs: I18N.LANGS, names: I18N.NAMES, platform: process.platform, loginItems: LOGIN_ITEMS }
      }
      case 'setOpenAtLogin': {
        const on = arg === true
        writeSettings({ openAtLogin: on })
        applyLoginItem(on)
        return { openAtLogin: on }
      }
      case 'setLang': {
        writeSettings({ lang: typeof arg === 'string' && I18N.LANGS.includes(arg) ? arg : null })
        updateTray()
        return { lang: lang() }
      }
      case 'openPanel': {
        // the address comes from the bridge (the paired server's panel), never from the window
        const url = lastState && lastState.panelUrl
        if (typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url)) await shell.openExternal(url)
        return { ok: !!url }
      }
      case 'copyCode': {
        // only a pairing code goes to the clipboard
        if (typeof arg === 'string' && /^[A-Z0-9]{3}-?[A-Z0-9]{3}$/.test(arg)) clipboard.writeText(arg)
        return { ok: true }
      }
      default: throw new Error('unknown_action')
    }
  })
}

// ------------------------------------------------------------------------------------------------
// Start
// ------------------------------------------------------------------------------------------------

function boot() {
  // the window asks for nothing: no camera, microphone, notifications, ... and no web requests leave it
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  setupIpc()
  const s = readSettings()
  if (!s.firstRunDone) { writeSettings({ firstRunDone: true }); applyLoginItem(s.openAtLogin) }
  tray = new Tray(trayIcon(false))
  tray.on('click', () => { if (win && win.isVisible() && win.isFocused()) win.hide(); else showWindow() })
  updateTray()
  startWorker()
  setInterval(poll, 4000)
  if (!startedHidden()) showWindow()
}

app.on('window-all-closed', () => { /* stays next to the clock */ })
app.on('activate', () => showWindow())
app.on('before-quit', () => {
  quitting = true
  // the worker ends with its channel; the background service keeps running (it is its own process)
  if (worker && worker.connected) { try { worker.disconnect() } catch { /* gone */ } }
})
