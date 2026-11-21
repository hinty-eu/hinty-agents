// @ts-check
// A system notification without any npm dependency (security review point 2: a remote switch-on of away mode must be
// visible at the computer). Best effort and fire-and-forget: Windows toast through PowerShell, macOS osascript, Linux
// notify-send when present. The text is built here from fixed words and a time (HH:MM), never from outside input.
import os from 'node:os'
import { spawn } from 'node:child_process'
import { childEnv, powershellExe, which } from './exec.js'

/** @param {number} at ms @returns {string} HH:MM local time */
export const hhmm = (at) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * @param {'remote_away'} kind @param {number} at
 * @returns {boolean} started
 */
export function systemNotify(kind, at) {
  if (kind !== 'remote_away') return false
  const title = 'Hinty Agents'
  const body = `Away mode was switched on remotely at ${hhmm(at)}. Not you? Run: npx hinty-agents away off`
  try {
    /** @type {[string, string[]] | null} */
    let cmd = null
    if (process.platform === 'win32') {
      const xml = `<toast><visual><binding template="ToastGeneric"><text>${title}</text><text>${body}</text></binding></visual></toast>`
      const ps = [
        "$ErrorActionPreference='Stop'",
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
        '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
        '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
        `$x.LoadXml('${xml}')`,
        '$t = New-Object Windows.UI.Notifications.ToastNotification $x',
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($t)",
      ].join('; ')
      cmd = [powershellExe(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')]]
    } else if (process.platform === 'darwin') {
      cmd = ['/usr/bin/osascript', ['-e', `display notification "${body}" with title "${title}"`]]
    } else {
      const ns = which('notify-send')
      if (ns) cmd = [ns, [title, body]]
    }
    if (!cmd) return false
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.homedir(), env: childEnv() })
    child.on('error', () => {})
    child.unref()
    return true
  } catch { return false }
}
