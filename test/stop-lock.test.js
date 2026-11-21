// Security review point 7: `stop` kills only our own service (signed ping or its command line), never a program that
// got the old pid after a reboot; a stale daemon.lock whose pid now belongs to another program does not block start;
// the service writes daemon.json of protocol v2 (no `secret`) and removes a stale one before it listens.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/hinty-agents.js', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hinty-stop-'))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

/** a harmless other program that happens to own a pid */
function bystander() {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  return c
}
const cli = (home, args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, HINTY_AGENTS_HOME: home, HERMES_HOME: home, HINTY_AGENTS_NO_NOTIFY: '1', NO_COLOR: '1' }, encoding: 'utf8', timeout: 60000, windowsHide: true })

test('stop: daemon.json pointing to another program (old pid reused) = that program is left alone, files removed', async () => {
  const home = tmp()
  const other = bystander()
  try {
    await sleep(200)
    fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ v: 2, pv: 2, pid: other.pid, port: 9, key: 'k'.repeat(43) }))
    fs.writeFileSync(path.join(home, 'daemon.lock'), String(other.pid))
    const r = cli(home, ['stop'])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /belongs to another program/)
    await sleep(300)
    assert.equal(alive(other.pid), true, 'the other program still runs')
    assert.equal(fs.existsSync(path.join(home, 'daemon.json')), false)
    // the same with an old-format daemon.json (v1)
    fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ v: 1, pid: other.pid, port: 9, secret: 'x' }))
    cli(home, ['stop'])
    await sleep(300)
    assert.equal(alive(other.pid), true)
  } finally { other.kill() }
})

test('start despite a stale lock owned by another program; daemon.json v2 without the key in clear field names; stop kills only it', async () => {
  const home = tmp()
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 1, api: 'http://127.0.0.1:9', bridgeToken: 't'.repeat(32), bridgeId: 'a'.repeat(24) }))
  const other = bystander()
  let daemonPid = 0
  try {
    await sleep(200)
    fs.writeFileSync(path.join(home, 'daemon.lock'), String(other.pid))
    // a stale daemon.json from a dead run (its port is nobody's)
    fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ v: 2, pv: 2, pid: other.pid, port: 9, key: 'z'.repeat(43) }))
    const env = { ...process.env, HINTY_AGENTS_HOME: home, HERMES_HOME: home, HINTY_AGENTS_NO_NOTIFY: '1' }
    const d = spawn(process.execPath, [CLI, 'daemon'], { env, stdio: 'ignore', windowsHide: true, detached: false })
    daemonPid = d.pid
    let info = null
    for (let i = 0; i < 100 && !(info && info.pid === d.pid); i++) {
      await sleep(100)
      try { info = JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8')) } catch { /* not yet */ }
    }
    assert.equal(info && info.pid, d.pid, 'the service started and wrote its own daemon.json')
    assert.equal(info.pv, 2)
    assert.equal(info.secret, undefined)
    assert.equal(typeof info.key, 'string')
    assert.equal(fs.readFileSync(path.join(home, 'daemon.lock'), 'utf8').trim(), String(d.pid))
    assert.match(fs.readFileSync(path.join(home, 'daemon.log'), 'utf8'), /lock_stale pid=\d+ why=not_our_service/)
    const st = cli(home, ['status'])
    assert.match(st.stdout, /Service:\s+running/)
    const r = cli(home, ['stop'])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    await sleep(500)
    assert.equal(alive(d.pid), false, 'our service stopped')
    assert.equal(alive(other.pid), true, 'the other program still runs')
  } finally {
    other.kill()
    if (daemonPid && alive(daemonPid)) { try { process.kill(daemonPid) } catch { /* gone */ } }
  }
})
