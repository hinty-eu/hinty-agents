// @ts-check
// `hinty-agents voice install|status|remove` (E3). `sherpa-onnx-node` (pinned) goes to ~/.hinty-agents/voice/ on
// demand, never into this package's dependencies. Models go to ~/.hinty-agents/models/<id>/: downloaded to a
// temporary file, size and sha256 checked, then renamed (a half-downloaded file is never taken for a model).
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { ensureHome, noteCreated, readJson, writeJson } from '../store.js'
import { npmLaunch, runSync } from '../exec.js'
import { DEFAULT_MODEL, MODELS, SHERPA_VERSION, VAD_MODEL, modelDir, modelsDir, voiceConfigFile, voiceDir } from './models.js'

/** @typedef {{ v: 1, model: string, verifiedAt: string }} VoiceConfig */

/** @returns {VoiceConfig | null} written only after a trial load succeeded */
export function readVoiceConfig() {
  const c = readJson(voiceConfigFile())
  return c && typeof c.model === 'string' && MODELS[c.model] ? c : null
}

/** @param {string} id @returns {{ ok: boolean, missing: string[] }} quick check by file size (the sum was checked at download) */
export function modelState(id) {
  const m = MODELS[id]
  if (!m) return { ok: false, missing: ['unknown model'] }
  const missing = []
  for (const f of m.files) {
    try { if (fs.statSync(path.join(modelDir(id), f.name)).size !== f.size) missing.push(f.name) } catch { missing.push(f.name) }
  }
  return { ok: missing.length === 0, missing }
}

export function sherpaInstalled() {
  try {
    const pkg = readJson(path.join(voiceDir(), 'node_modules', 'sherpa-onnx-node', 'package.json'))
    return !!pkg && pkg.version === SHERPA_VERSION
  } catch { return false }
}

/** @returns {any} the sherpa-onnx-node module loaded from ~/.hinty-agents/voice (throws when it is not there) */
export function loadSherpa() {
  const req = createRequire(path.join(voiceDir(), 'package.json'))
  return req('sherpa-onnx-node')
}

/** True when the speech can be used right now (sherpa, VAD and the chosen model are in place and passed the trial). */
export function voiceReady() {
  const c = readVoiceConfig()
  return !!c && sherpaInstalled() && modelState(c.model).ok && modelState(VAD_MODEL).ok
}

/** @param {number} n */
export const fmtMB = (n) => `${(n / 1048576).toFixed(n > 10485760 ? 0 : 1)} MB`

/** @param {string} dir */
function dirSize(dir) {
  let t = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      t += e.isDirectory() ? dirSize(p) : fs.statSync(p).size
    }
  } catch { /* missing */ }
  return t
}

/** @param {string} file @returns {Promise<string>} */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })
}

/**
 * @param {import('./models.js').ModelFile} f @param {string} dir
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function downloadFile(f, dir, onProgress) {
  const dest = path.join(dir, f.name)
  try {
    if (fs.statSync(dest).size === f.size) {
      // an existing file is trusted only after its sha256 matches
      if (await sha256File(dest) === f.sha256) return false
      fs.unlinkSync(dest)
    }
  } catch { /* not there */ }
  fs.mkdirSync(dir, { recursive: true })
  noteCreated(dir)
  const tmp = `${dest}.${process.pid}.part`
  const res = await fetch(f.url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) ${f.name}`)
  const hash = crypto.createHash('sha256')
  let done = 0
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length
      // a source that sends more than the model's size is cut off at once (it cannot fill the disk)
      if (done > f.size) return cb(new Error(`download of ${f.name} is larger than expected (${f.size} bytes); stopped`))
      hash.update(chunk); onProgress?.(done, f.size); cb(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(/** @type {any} */ (res.body)), meter, fs.createWriteStream(tmp, { mode: 0o600 }))
    const sum = hash.digest('hex')
    if (done !== f.size || sum !== f.sha256) throw new Error(`checksum mismatch for ${f.name} (got ${done} bytes, sha256 ${sum.slice(0, 12)}...)`)
    fs.renameSync(tmp, dest)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* gone */ }
    throw e
  }
  return true
}

/** The voice folder's package.json and lock file, shipped with this package (every package pinned with `integrity`). */
export const VOICE_PACKAGE = () => fileURLToPath(new URL('./voice-package.json', import.meta.url))
export const VOICE_LOCK = () => fileURLToPath(new URL('./voice-package-lock.json', import.meta.url))

function installSherpa() {
  fs.mkdirSync(voiceDir(), { recursive: true })
  noteCreated(voiceDir())
  // security review point 11 / review 2: the exact tree from our lock file (sherpa-onnx-node and its per-platform
  // packages, each with a sha512 `integrity` npm checks), installed with `npm ci --ignore-scripts`: no version is picked
  // at install time and no package script runs (sherpa-onnx-node 2.0.2 ships prebuilt binaries and needs none)
  fs.copyFileSync(VOICE_PACKAGE(), path.join(voiceDir(), 'package.json'))
  fs.copyFileSync(VOICE_LOCK(), path.join(voiceDir(), 'package-lock.json'))
  // npm without a shell (security review points 6 and 11): node + npm-cli.js, the folder as one argument (a space in
  // the user name no longer splits it, a `&` is not run by cmd.exe), started in the voice folder
  const npm = npmLaunch()
  if (!npm) throw new Error('npm was not found next to this Node.js or on PATH')
  const r = runSync(npm, ['ci', '--prefix', voiceDir(), '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
    { stdio: 'inherit', cwd: voiceDir() })
  if (r.status !== 0 || !sherpaInstalled()) throw new Error('npm could not install sherpa-onnx-node (see the message above)')
}

/**
 * @typedef {{ phase: 'engine' | 'download' | 'check', done: number, total: number, file?: string }} VoiceProgress
 * bytes of every file of the VAD and the model together (`done` counts a file already in place as done)
 */

/**
 * @param {{ model?: string, out?: (s: string) => void, selfTest?: (id: string) => Promise<void>,
 *   progress?: (p: VoiceProgress) => void, installEngine?: () => void }} [o]
 *   progress: for a progress bar (the desktop app); installEngine: tests only
 */
export async function installVoice(o = {}) {
  const id = o.model || DEFAULT_MODEL
  const out = o.out || (() => {})
  const progress = o.progress || (() => {})
  const m = MODELS[id]
  if (!m || m.kind === 'vad') throw new Error(`unknown model "${id}" (choose: ${Object.keys(MODELS).filter((k) => MODELS[k].kind !== 'vad').join(', ')})`)
  ensureHome()
  const total = [VAD_MODEL, id].reduce((a, mid) => a + MODELS[mid].files.reduce((b, f) => b + f.size, 0), 0)
  progress({ phase: 'engine', done: 0, total })
  if (sherpaInstalled()) out(`sherpa-onnx-node ${SHERPA_VERSION}: already installed`)
  else { out(`installing sherpa-onnx-node ${SHERPA_VERSION} into ${voiceDir()} ...`); (o.installEngine || installSherpa)() }
  let before = 0
  for (const mid of [VAD_MODEL, id]) {
    for (const f of MODELS[mid].files) {
      let lastPct = -1
      const got = await downloadFile(f, modelDir(mid), (d, t) => {
        const pct = Math.floor((d / t) * 100)
        if (t > 5e6 && pct !== lastPct && pct % 10 === 0) { lastPct = pct; out(`  ${f.name}: ${pct}% (${fmtMB(d)} / ${fmtMB(t)})`) }
        progress({ phase: 'download', done: before + d, total, file: f.name })
      })
      before += f.size
      progress({ phase: 'download', done: before, total, file: f.name })
      out(got ? `  ${f.name}: ok (${fmtMB(f.size)}, sha256 checked)` : `  ${f.name}: already there`)
    }
  }
  progress({ phase: 'check', done: total, total })
  out('trial load of the model ...')
  const selfTest = o.selfTest || (async (/** @type {string} */ x) => { const { trialLoad } = await import('./sherpa.js'); await trialLoad(x) })
  await selfTest(id)
  writeJson(voiceConfigFile(), { v: 1, model: id, verifiedAt: new Date().toISOString() })
  out(`voice is ready (model ${id})`)
  return id
}

/** @returns {Record<string, any>} */
export function voiceStatus() {
  const c = readVoiceConfig()
  const models = Object.values(MODELS).map((m) => ({
    id: m.id, kind: m.kind, installed: modelState(m.id).ok,
    sizeOnDisk: dirSize(modelDir(m.id)), download: m.files.reduce((a, f) => a + f.size, 0),
  }))
  return {
    sherpa: sherpaInstalled() ? SHERPA_VERSION : null,
    model: c ? c.model : null, verifiedAt: c ? c.verifiedAt : null,
    ready: voiceReady(), models, sherpaOnDisk: dirSize(voiceDir()),
  }
}

/** Remove the voice packages and every model; the service (if running) is told by the caller. */
export function removeVoice() {
  let freed = dirSize(voiceDir()) + dirSize(modelsDir())
  fs.rmSync(voiceDir(), { recursive: true, force: true })
  fs.rmSync(modelsDir(), { recursive: true, force: true })
  try { fs.unlinkSync(voiceConfigFile()) } catch { /* none */ }
  return freed
}
