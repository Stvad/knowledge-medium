import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'
import {loadOrCreateChannelSecret} from '../src/channelSecret'

let dir: string
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-tasks-secret-'))
  vi.stubEnv('AGENT_RUNTIME_CONFIG_DIR', dir)
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await fs.rm(dir, {recursive: true, force: true})
})

describe('loadOrCreateChannelSecret', () => {
  it('creates once and returns the same value on later loads', async () => {
    const first = await loadOrCreateChannelSecret()
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(await loadOrCreateChannelSecret()).toBe(first)
  })

  it('two concurrent first-creates converge on ONE secret (daemon + MCP server race)', async () => {
    await fs.rm(path.join(dir, 'claude-tasks-channel.secret'), {force: true})
    // Both pass the ENOENT read before either writes; without an atomic
    // create the loser keeps a secret the file no longer contains and
    // every channel delivery 401s until a restart.
    const [a, b] = await Promise.all([loadOrCreateChannelSecret(), loadOrCreateChannelSecret()])
    expect(a).toBe(b)
    const onDisk = (await fs.readFile(path.join(dir, 'claude-tasks-channel.secret'), 'utf8')).trim()
    expect(onDisk).toBe(a)
  })
})
