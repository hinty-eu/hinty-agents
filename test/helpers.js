// Shared test helpers: a fake service on 127.0.0.1 that speaks the local protocol v2 and writes daemon.json for it.
import fs from 'node:fs'
import path from 'node:path'
import { createLocalServer, listenLoopback } from '../src/local-http.js'
import { daemonRecord } from '../src/localauth.js'
import { newSecret } from '../src/crypto.js'

/** @param {string} dir @param {{ pid?: number, port: number, key: string }} o */
export function writeDaemon(dir, o) {
  fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify(daemonRecord({ pid: o.pid ?? process.pid, port: o.port, key: o.key })))
}

/**
 * @param {string} dir @param {Record<string, any>} routes @param {{ key?: string, writeKey?: string }} [o]
 * @returns {Promise<import('node:http').Server & { key: string, port: number }>}
 */
export async function fakeService(dir, routes, o = {}) {
  const key = o.key || newSecret()
  const s = /** @type {any} */ (createLocalServer({ key, routes }))
  const port = await listenLoopback(s)
  writeDaemon(dir, { port, key: o.writeKey || key })
  s.key = key
  s.port = port
  return s
}
