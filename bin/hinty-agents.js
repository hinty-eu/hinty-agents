#!/usr/bin/env node
// hinty-agents: supervise your AI coding agents from Hinty smart-glasses and the Hinty panel.
const major = Number(process.versions.node.split('.')[0])
if (major < 20) {
  console.error(`hinty-agents needs Node.js 20 or newer (this is ${process.versions.node}).`)
  process.exit(1)
}
const { main } = await import('../src/cli.js')
try {
  process.exitCode = (await main(process.argv.slice(2))) ?? 0
} catch (e) {
  console.error(`hinty-agents: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
}
