// @vitest-environment node
/**
 * The loop's cadence contract: the pass that computed the answer is the only
 * thing that sets the next delay.
 *
 * The cases that need saying, because a run that decides nothing still has to
 * leave the loop somewhere sensible: one that refuses its own result returns a
 * delay like any other, and one that THROWS has no return value to give one, so
 * `onFailureDelayMs` answers for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cadencedIdleJob } from '../cadencedIdleJob'

const FIRST = 1_000
const REPEAT = 100_000
const RETRY = 500

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** Advance past the floor timer AND the idle deferral behind it — the two are
 *  scheduled separately (see the module docblock), so reaching the floor only
 *  queues the idle callback that actually runs the job. */
const settle = async (job: { drain: () => Promise<void> }, ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
  await vi.advanceTimersByTimeAsync(1)
  await job.drain()
}

describe('cadencedIdleJob', () => {
  const make = () => cadencedIdleJob({ firstDelayMs: FIRST, repeatDelayMs: REPEAT, label: 'test' })

  it('re-arms on the delay the run returned, not the standing cadence', async () => {
    const job = make()
    const at: number[] = []
    const { stop } = job.start(async () => {
      at.push(Date.now())
      // Only the first pass asks to come back soon; the second takes the default.
      return at.length === 1 ? RETRY : undefined
    })

    await settle(job, FIRST)
    expect(at).toHaveLength(1)

    await settle(job, RETRY)
    expect(at).toHaveLength(2)

    // The default now applies, so nothing fires at the short delay.
    await settle(job, RETRY)
    expect(at).toHaveLength(2)
    await settle(job, REPEAT)
    expect(at).toHaveLength(3)
    stop()
  })

  it('retries soon after a run throws instead of waiting out the cadence', async () => {
    const job = make()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let runs = 0
    const { stop } = job.start(async () => {
      runs++
      if (runs === 1) throw new Error('transient')
    }, { onFailureDelayMs: RETRY })

    await settle(job, FIRST)
    expect(runs).toBe(1)

    await settle(job, RETRY)
    expect(runs).toBe(2)
    stop()
  })

  // Without an explicit failure delay a throw is not special — the loop keeps
  // its standing cadence rather than inventing a retry the caller did not ask
  // for.
  it('falls back to the cadence when a throwing run has no failure delay', async () => {
    const job = make()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let runs = 0
    const { stop } = job.start(async () => { runs++; throw new Error('transient') })

    await settle(job, FIRST)
    expect(runs).toBe(1)
    await settle(job, RETRY)
    expect(runs).toBe(1)
    await settle(job, REPEAT)
    expect(runs).toBe(2)
    stop()
  })

  // For work that answers the loop's question from outside it — a manual
  // refresh. The pending run was armed on a delay computed before that work
  // existed, so without this the loop waits out a cadence chosen in ignorance
  // of it.
  it('re-arms the pending run, replacing the delay the last run chose', async () => {
    const job = make()
    let runs = 0
    const loop = job.start(async () => { runs++ })

    await settle(job, FIRST)
    expect(runs).toBe(1)
    // Armed on REPEAT; nothing is due for a long time.
    await settle(job, RETRY)
    expect(runs).toBe(1)

    loop.rearmIn(RETRY)
    await settle(job, RETRY)
    expect(runs).toBe(2)

    // ...and the old timer is REPLACED, not left to fire as well: reaching the
    // original cadence produces no extra run beyond the next scheduled one.
    await settle(job, REPEAT)
    expect(runs).toBe(3)
    await settle(job, RETRY)
    expect(runs).toBe(3)
    loop.stop()
  })

  it('ignores a re-arm after disposal', async () => {
    const job = make()
    let runs = 0
    const loop = job.start(async () => { runs++ })
    await settle(job, FIRST)
    loop.stop()

    loop.rearmIn(RETRY)

    await settle(job, REPEAT * 2)
    expect(runs).toBe(1)
  })

  it('stops re-arming once disposed', async () => {
    const job = make()
    let runs = 0
    const { stop } = job.start(async () => { runs++ })

    await settle(job, FIRST)
    expect(runs).toBe(1)
    stop()
    await settle(job, REPEAT * 2)
    expect(runs).toBe(1)
  })
})
