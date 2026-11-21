// A stand-in for the `hermes` CLI in tests: --version, plugins enable|disable, config set <dotted.key> <value>.
// Config lives in $HERMES_HOME/config.yaml (block-style YAML written from a JSON twin), calls are logged to $FAKE_HERMES_LOG.
import fs from 'node:fs'
import path from 'node:path'

const [, , ...args] = process.argv
const home = process.env.HERMES_HOME
const log = (line) => fs.appendFileSync(process.env.FAKE_HERMES_LOG, line + '\n')
const twin = path.join(home, 'config.json')
const read = () => { try { return JSON.parse(fs.readFileSync(twin, 'utf8')) } catch { return {} } }
const dump = (o, ind = 0) => Object.entries(o).map(([k, v]) => (v && typeof v === 'object' ? `${' '.repeat(ind)}${k}:\n${dump(v, ind + 2)}` : `${' '.repeat(ind)}${k}: ${v}`)).join('\n')

if (args[0] === '--version') { console.log('Hermes Agent v' + (process.env.FAKE_HERMES_VERSION || '0.23.3')); process.exit(0) }
if (args[0] === 'plugins') { log(args.join(' ')); process.exit(0) }
if (args[0] === 'config' && args[1] === 'set') {
  log(args.join(' '))
  const cfg = read()
  const keys = args[2].split('.')
  let o = cfg
  for (const k of keys.slice(0, -1)) o = o[k] = (o[k] && typeof o[k] === 'object') ? o[k] : {}
  o[keys.at(-1)] = args[3]
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(twin, JSON.stringify(cfg))
  fs.writeFileSync(path.join(home, 'config.yaml'), dump(cfg) + '\n')
  process.exit(0)
}
process.exit(2)
