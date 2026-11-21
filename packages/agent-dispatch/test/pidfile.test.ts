import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {acquirePidfile, releasePidfile} from '../src/pidfile'

/**
 * Seeded jitter injected before every fs op (mock below). The two-winner
 * races in acquirePidfile live in the gaps BETWEEN fs calls (recheck→rm vs
 * a rival's create); at native speed those gaps are microseconds and a
 * bare Promise.allSettled race almost never lands in them. Millisecond
 * jitter makes the schedule space the test explores dominated by the
 * seed, so a run that kills a regression kills it on every run.
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
      if (jitter.active) await new Promise(resolve => setTimeout(resolve, Math.floor(jitter.next() * 3)))
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dispatch-pid-'))
  file = path.join(dir, 'daemon.pid')
})
afterAll(async () => {
  await fs.rm(dir, {recursive: true, force: true})
})
beforeEach(async () => {
  jitter.active = false
  for (const entry of await fs.readdir(dir)) await fs.rm(path.join(dir, entry), {recursive: true, force: true})
})

const DEAD_PID = 999_999
const alive = (pid: number) => pid !== DEAD_PID

describe('acquirePidfile', () => {
  it('creates the pidfile and release removes only its own', async () => {
    await acquirePidfile({file, pid: 111, isAlive: alive})
    expect((await fs.readFile(file, 'utf8')).trim()).toBe('111')

    await releasePidfile({file, pid: 222}) // not ours — must stay
    expect((await fs.readFile(file, 'utf8')).trim()).toBe('111')
    await releasePidfile({file, pid: 111})
    await expect(fs.readFile(file, 'utf8')).rejects.toMatchObject({code: 'ENOENT'})
  })

  it('refuses when a live daemon holds the pidfile', async () => {
    await fs.writeFile(file, '111\n')
    await expect(acquirePidfile({file, pid: 222, isAlive: alive})).rejects.toThrow(/already running/)
  })

  it('takes over a stale pidfile', async () => {
    await fs.writeFile(file, `${DEAD_PID}\n`)
    await acquirePidfile({file, pid: 111, isAlive: alive})
    expect((await fs.readFile(file, 'utf8')).trim()).toBe('111')
  })

  it('two concurrent stale takeovers admit exactly ONE daemon', async () => {
    await fs.writeFile(file, `${DEAD_PID}\n`)
    // Both contenders read the same dead pid; without an atomic gate the
    // loser's rm can land on the winner's FRESH pidfile and both acquire.
    const results = await Promise.allSettled([
      acquirePidfile({file, pid: 111, isAlive: alive}),
      acquirePidfile({file, pid: 222, isAlive: alive}),
    ])
    const winners = results.filter(result => result.status === 'fulfilled')
    expect(winners).toHaveLength(1)
    const holder = (await fs.readFile(file, 'utf8')).trim()
    expect(['111', '222']).toContain(holder)
  })

  it('stale takeover admits exactly ONE daemon across adversarial schedules', {timeout: 60_000}, async () => {
    // Every round races CONTENDERS acquirers over one stale pidfile under
    // a fresh seeded-jitter schedule. Regressions this exists to catch
    // (both produced TWO fulfilled acquires): (1) create via
    // writeFile(wx) — create-then-write, so a rival reading the empty
    // window gets pid 0 = "stale" and steals a live daemon's file;
    // (2) rm under the takeover gate after a recheck that saw ABSENCE —
    // the rm lands on a rival's fresh ungated create.
    const CONTENDERS = 6
    const ROUNDS = 120
    for (let round = 0; round < ROUNDS; round += 1) {
      for (const entry of await fs.readdir(dir)) await fs.rm(path.join(dir, entry), {recursive: true, force: true})
      await fs.writeFile(file, `${DEAD_PID}\n`)
      jitter.seed(round + 1)
      jitter.active = true
      try {
        const pids = Array.from({length: CONTENDERS}, (_, i) => 1000 + i)
        const results = await Promise.allSettled(pids.map(pid => acquirePidfile({file, pid, isAlive: alive})))
        const winners = pids.filter((_, i) => results[i].status === 'fulfilled')
        expect(winners, `round ${round}: winners [${winners.join(', ')}]`).toHaveLength(1)
        const holder = Number((await fs.readFile(file, 'utf8')).trim())
        expect(holder, `round ${round}: pidfile holder`).toBe(winners[0])
        for (const result of results) {
          if (result.status === 'rejected') {
            expect(String(result.reason)).toMatch(/already running|lost a startup race/)
          }
        }
      } finally {
        jitter.active = false
      }
    }
  })
})
