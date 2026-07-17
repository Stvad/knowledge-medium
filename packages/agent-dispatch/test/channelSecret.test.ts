import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'
import {loadOrCreateChannelSecret} from '../src/channelSecret'

let dir: string
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dispatch-secret-'))
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

  it('concurrent first-creates converge on ONE secret (daemon + MCP server race)', async () => {
    await fs.rm(path.join(dir, 'agent-dispatch-channel.secret'), {force: true})
    // Every caller passes the ENOENT read before any writes; without an atomic
    // create the losers keep a secret the file no longer contains and every
    // channel delivery 401s until a restart. Fanning out past two also exercises
    // the create→fill window that a non-atomic writer would leave: a loser must
    // never observe (and reclaim) a half-written file out from under the winner.
    const results = await Promise.all(
      Array.from({length: 12}, () => loadOrCreateChannelSecret()),
    )
    expect(new Set(results).size).toBe(1)
    const onDisk = (await fs.readFile(path.join(dir, 'agent-dispatch-channel.secret'), 'utf8')).trim()
    expect(onDisk).toBe(results[0])
  })
})
