import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {loadOrCreateChannelSecret} from '../src/channelSecret'

/**
 * Seeded jitter injected before every fs op (mock below), same technique as
 * pidfile.test.ts. The destructive reclaim race lives in the gap between one
 * caller's "empty" read and its delete vs. another caller completing a full
 * heal; at native speed that gap is microseconds and a bare Promise.all almost
 * never lands in it. Millisecond jitter makes the schedule space the seed
 * explores, so a run that kills the regression kills it on every run.
 */
const jitter = vi.hoisted(() => ({
  active: false,
  state: 1,
  seed(value: number) {
    this.state = value >>> 0 || 1
  },
  /** mulberry32 — tiny seeded PRNG, uniform in [0, 1). */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  },
}))

vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const wrap = <Args extends unknown[], Result>(fn: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      if (jitter.active) await new Promise(resolve => setTimeout(resolve, Math.floor(jitter.next() * 8)))
      return fn(...args)
    }
  const wrapped = {
    ...real,
    mkdir: wrap(real.mkdir),
    writeFile: wrap(real.writeFile),
    readFile: wrap(real.readFile),
    link: wrap(real.link),
    rename: wrap(real.rename),
    rm: wrap(real.rm),
    rmdir: wrap(real.rmdir),
    stat: wrap(real.stat),
    unlink: wrap(real.unlink),
  } as typeof real
  return {...wrapped, default: wrapped}
})

let dir: string
let file: string
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dispatch-secret-'))
  file = path.join(dir, 'agent-dispatch-channel.secret')
  vi.stubEnv('AGENT_RUNTIME_CONFIG_DIR', dir)
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await fs.rm(dir, {recursive: true, force: true})
})
beforeEach(async () => {
  jitter.active = false
  for (const entry of await fs.readdir(dir)) await fs.rm(path.join(dir, entry), {recursive: true, force: true})
})

describe('loadOrCreateChannelSecret', () => {
  it('creates once and returns the same value on later loads', async () => {
    const first = await loadOrCreateChannelSecret()
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(await loadOrCreateChannelSecret()).toBe(first)
  })

  it('concurrent first-creates converge on ONE secret (daemon + MCP server race)', async () => {
    // Every caller passes the ENOENT read before any writes; without an atomic
    // create the losers keep a secret the file no longer contains and every
    // channel delivery 401s until a restart. Fanning out past two also exercises
    // the create→fill window that a non-atomic writer would leave: a loser must
    // never observe (and reclaim) a half-written file out from under the winner.
    jitter.active = true
    jitter.seed(0x5eed)
    const results = await Promise.all(
      Array.from({length: 12}, () => loadOrCreateChannelSecret()),
    )
    expect(new Set(results).size).toBe(1)
    const onDisk = (await fs.readFile(file, 'utf8')).trim()
    expect(onDisk).toBe(results[0])
  })

  it('concurrent callers heal a pre-existing empty (corrupt) file to ONE secret', async () => {
    // A crash between an old create-then-write's two steps could leave the file
    // present but empty. Reclaiming it is a delete+recreate; without serializing
    // that, two callers each delete-and-recreate from a stale "empty" read and
    // one clobbers the other's freshly returned secret (divergence). The reclaim
    // gate must make them converge on one healed secret.
    //
    // The destructive interleaving lives in a narrow window, so this races a
    // wide fan-out over several seeded schedules: with the gate every round
    // converges; drop it and a round diverges ~90% of the time (measured), so a
    // regression fails here reliably while the fixed code is deterministically
    // green (the gate guarantees convergence on every schedule).
    for (let round = 0; round < 5; round += 1) {
      for (const entry of await fs.readdir(dir)) await fs.rm(path.join(dir, entry), {recursive: true, force: true})
      await fs.writeFile(file, '')
      jitter.active = true
      jitter.seed(0xc0ffee + round)
      const results = await Promise.all(
        Array.from({length: 24}, () => loadOrCreateChannelSecret()),
      )
      jitter.active = false
      expect(results[0]).toMatch(/^[0-9a-f]{64}$/)
      expect(new Set(results).size).toBe(1)
      const onDisk = (await fs.readFile(file, 'utf8')).trim()
      expect(onDisk).toBe(results[0])
    }
  }, 30_000)

  it('recovers from a reclaim gate a crashed process left behind (never throws)', async () => {
    // A process that crashed mid-reclaim leaves the `.reclaim` gate dir with the
    // secret file still empty. A caller starting inside the stale window must
    // wait the gate out and reap it — NOT burn a short retry budget and throw
    // (which at the unguarded MCP entrypoint would crash the server, so the
    // channel would fail to start for the whole stale window instead of healing).
    // Use a short stale window so the wait is a few hundred ms rather than 10s.
    await fs.writeFile(file, '')
    await fs.mkdir(`${file}.reclaim`) // gate a crashed reclaimer left behind (fresh, not yet stale)
    const start = Date.now()
    const secret = await loadOrCreateChannelSecret({reclaimStaleMs: 300})
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect((await fs.readFile(file, 'utf8')).trim()).toBe(secret)
    // It waited the gate out rather than reaping instantly or giving up early.
    expect(Date.now() - start).toBeGreaterThanOrEqual(250)
    // ...and cleaned the gate up.
    expect(await fs.stat(`${file}.reclaim`).then(() => true, () => false)).toBe(false)
  }, 30_000)
})
