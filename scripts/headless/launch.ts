import {mkdir, stat} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {DEVICE_STORAGE_FILENAME, readConfig} from './config.ts'

const [action, file, ...extra] = process.argv.slice(2)
const releaseStaleQueue = action === 'run' && extra.length === 1 && extra[0] === '--release-stale-queue'
if ((action !== 'login' && action !== 'run') || !file || (extra.length > 0 && !releaseStaleQueue)) {
  throw new Error('Usage: pnpm headless login <config.json> or pnpm headless run <config.json> [--release-stale-queue]')
}
const {stateDir} = await readConfig(file)
await mkdir(stateDir, {recursive: true, mode: 0o700})
if (((await stat(stateDir)).mode & 0o777) !== 0o700) throw new Error('State directory must have mode 0700')
const script = (name: string) => join(import.meta.dirname, name)
// Keep the supervisor's PID and signals when enabling persistent Web Storage.
process.execve!(process.execPath, [
  process.execPath, '--experimental-webstorage', `--localstorage-file=${join(stateDir, DEVICE_STORAGE_FILENAME)}`,
  fileURLToPath(import.meta.resolve('vite-node/cli')), '--config', script('vite.config.ts'),
  script('cli.ts'), '--', action, file, ...extra,
], process.env)
