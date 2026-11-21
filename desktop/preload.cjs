'use strict'
// The only bridge between the window and the app: a fixed set of calls (main.cjs checks each again) and two event streams.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hinty', {
  /** a request to the bridge (state, pairStart, away, install, ...) */
  call: (method, params) => ipcRenderer.invoke('hinty:call', String(method), params && typeof params === 'object' ? { ...params } : {}),
  /** app settings: info, setOpenAtLogin, setLang, openPanel, copyCode */
  app: (action, arg) => ipcRenderer.invoke('hinty:app', String(action), arg),
  onState: (fn) => { ipcRenderer.on('hinty:state', (_e, s) => fn(s)) },
  onEvent: (fn) => { ipcRenderer.on('hinty:event', (_e, ev, d) => fn(String(ev), d)) },
})
