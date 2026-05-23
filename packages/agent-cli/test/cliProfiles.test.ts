import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const cliScript = path.resolve(here, '../dist/cli.js')

let tempDir: string
let tokenFile: string

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runtime-cli-'))
  tokenFile = path.join(tempDir, 'agent-token.json')
})

afterEach(async () => {
  await fs.rm(tempDir, {recursive: true, force: true})
})

const runCli = async (
  args: string[],
  env: Record<string, string> = {},
) => execFileAsync(process.execPath, [cliScript, ...args], {
  env: {
    ...process.env,
    AGENT_RUNTIME_PROFILE: '',
    AGENT_RUNTIME_TOKEN: '',
    AGENT_RUNTIME_TOKEN_FILE: tokenFile,
    // Direct-token connect saves before verification; a dead explicit URL
    // keeps the test from auto-starting a bridge process.
    AGENT_RUNTIME_URL: 'http://127.0.0.1:9',
    ...env,
  },
})

describe('agent runtime CLI profiles', () => {
  it('stores and lists independent named token profiles', async () => {
    await runCli(['--profile', 'work', 'connect', 'TOKEN-WORK'])
    await runCli(['connect', 'TOKEN-DEFAULT'])

    const {stdout} = await runCli(['profiles'])
    const listing = JSON.parse(stdout)

    expect(listing.selectedProfile).toBe('default')
    expect(listing.profiles).toEqual([
      {name: 'default', savedAt: expect.any(Number), selected: true},
      {name: 'work', savedAt: expect.any(Number), selected: false},
    ])

    const stored = JSON.parse(await fs.readFile(tokenFile, 'utf8'))
    expect(stored).toMatchObject({
      profiles: {
        default: {token: 'TOKEN-DEFAULT', savedAt: expect.any(Number)},
        work: {token: 'TOKEN-WORK', savedAt: expect.any(Number)},
      },
    })
  })

  it('selects profiles from AGENT_RUNTIME_PROFILE', async () => {
    await runCli(['--profile', 'work', 'connect', 'TOKEN-WORK'])

    const {stdout} = await runCli(['profiles'], {
      AGENT_RUNTIME_PROFILE: 'work',
    })
    const listing = JSON.parse(stdout)

    expect(listing.selectedProfile).toBe('work')
    expect(listing.profiles).toEqual([
      {name: 'work', savedAt: expect.any(Number), selected: true},
    ])
  })

  it('treats the legacy single-token file as the default profile', async () => {
    await fs.writeFile(tokenFile, JSON.stringify({token: 'TOKEN-LEGACY', savedAt: 123}, null, 2))

    const {stdout} = await runCli(['profiles'])
    const listing = JSON.parse(stdout)

    expect(listing.profiles).toEqual([
      {name: 'default', savedAt: 123, selected: true},
    ])
  })

  it('removes only the selected profile on disconnect', async () => {
    await runCli(['--profile', 'work', 'connect', 'TOKEN-WORK'])
    await runCli(['connect', 'TOKEN-DEFAULT'])

    await runCli(['--profile', 'work', 'disconnect'])

    const stored = JSON.parse(await fs.readFile(tokenFile, 'utf8'))
    expect(stored.profiles).toEqual({
      default: {token: 'TOKEN-DEFAULT', savedAt: expect.any(Number)},
    })
  })

  it('removes a named profile without selecting it first', async () => {
    await runCli(['--profile', 'work', 'connect', 'TOKEN-WORK'])
    await runCli(['connect', 'TOKEN-DEFAULT'])

    await runCli(['remove-profile', 'work'])

    const stored = JSON.parse(await fs.readFile(tokenFile, 'utf8'))
    expect(stored.profiles).toEqual({
      default: {token: 'TOKEN-DEFAULT', savedAt: expect.any(Number)},
    })
  })

  it('supports disconnect-profile as a named removal alias', async () => {
    await runCli(['--profile', 'work', 'connect', 'TOKEN-WORK'])

    await runCli(['disconnect-profile', 'work'])

    await expect(fs.readFile(tokenFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
