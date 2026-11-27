import {execFile} from 'node:child_process'
import {mkdtemp, readdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {afterEach, beforeEach, expect, it} from 'vitest'
import {DEVICE_STORAGE_FILENAME} from './config'

const run = promisify(execFile)
const fixtureKey = 'fixture-key'
const launch = join(import.meta.dirname, 'launch.ts')
let dir: string
let config: string
let stateDir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'headless-storage-'))
  config = join(dir, 'config.json')
  stateDir = join(dir, 'device')
  await writeFile(config, JSON.stringify({workspaceId: 'fixture', profile: 'test', mode: 'plaintext', stateDir: 'device'}))
})
afterEach(async () => { await rm(dir, {recursive: true, force: true}) })

const set = (input: string, key = fixtureKey) => {
  const child = run(process.execPath, [launch, 'storage', 'set', config, key], {
    env: {PATH: process.env.PATH}, timeout: 15_000,
  })
  child.child.stdin!.end(input)
  return child
}

const read = async (key = fixtureKey) => {
  const {stdout} = await run(process.execPath, [
    `--localstorage-file=${join(stateDir, DEVICE_STORAGE_FILENAME)}`,
    '-e', 'process.stdout.write(JSON.stringify(localStorage.getItem(process.argv[1])))', key,
  ])
  return JSON.parse(stdout)
}

// The two Node processes took 5.5 s in a loaded run.
it('persists the exact storage value for an empty key without printing it', async () => {
  const value = '  synthetic-device-secret  '
  const {stdout, stderr} = await set(`${value}\n`, '')
  expect(stdout + stderr).not.toContain(value.trim())
  expect(await read('')).toBe(value)
  expect(await readdir(stateDir)).toEqual([DEVICE_STORAGE_FILENAME])
}, 25_000)

// The terminal session and readback took 1.8 s in a loaded run.
it('accepts a terminal value without echoing typed characters', async () => {
  const {stdout, stderr} = await run('python3', [join(import.meta.dirname, 'test/storageTerminal.py'),
    process.execPath, launch, 'storage', 'set', config, fixtureKey], {env: {PATH: process.env.PATH}, timeout: 25_000})
  expect(stdout).toContain('Storage value: ')
  expect(stdout + stderr).not.toContain('synthetic-terminal-secret')
  expect(await read()).toBe('synthetic-terminal-secret')
}, 35_000)

// The two launches and readback took 2.5 s in a loaded run.
it('leaves the stored value in place when stdin closes without a line', async () => {
  await set('existing\n')
  await expect(set('')).rejects.toMatchObject({code: 1, stderr: expect.stringContaining('No storage value received')})
  expect(await read()).toBe('existing')
}, 40_000)
