// @vitest-environment node
import {describe, expect, it, vi} from 'vitest'
import {PendingIdleJobs, type ParkHandle} from '@/data/internals/idleMarkerJobs'

/** Run the deferred callback inline, so a test controls when a job enters the
 *  pending set without leaning on a timer. */
const immediate = (fn: () => void): void => { fn() }

/** A promise plus the lever that settles it — a job body's stand-in for work
 *  that finishes when the test says so. */
const gate = () => {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return {promise, open}
}

/** Resolves once `drain()` has returned; the flag is what the assertions read,
 *  so a drain that never settles fails the poll rather than the test's timeout. */
const startDrain = (jobs: PendingIdleJobs) => {
  const state = {done: false}
  const settled = jobs.drain().then(() => { state.done = true })
  return {state, settled}
}

const expectDrained = (state: {done: boolean}): Promise<void> =>
  vi.waitFor(() => expect(state.done).toBe(true), {timeout: 5_000, interval: 10})

// The work here is microtasks — the whole file measures ~100ms of test time.
// The budget is for the POLLS: each is 5s, and an enclosing timeout at vitest's
// 5s default would expire first, reporting a drain regression as the opaque
// "Test timed out" this file exists to replace.
describe('PendingIdleJobs.drain', {timeout: 20_000}, () => {
  it('awaits a job that is progressing', async () => {
    const jobs = new PendingIdleJobs(immediate)
    const work = gate()
    jobs.schedule(() => work.promise)

    const drain = startDrain(jobs)
    await vi.waitFor(() => expect(jobs.size).toBe(1), {timeout: 5_000, interval: 10})
    expect(drain.state.done).toBe(false)

    work.open()
    await expectDrained(drain.state)
    await drain.settled
  })

  // #1015: the job parks AFTER the drain has started awaiting it, which is the
  // shape the seed-materialization pass has — a `workspace_members` read, then a
  // subscription wait for a row only sync can deliver. Without the park signal
  // waking it, the drain sits on that job until the test times out.
  it('returns when the only pending job parks mid-drain', async () => {
    const jobs = new PendingIdleJobs(immediate)
    const external = gate()
    let release: (() => void) | undefined
    jobs.schedule(async (park: ParkHandle) => {
      await Promise.resolve()
      release = park()
      await external.promise
      release()
    })

    const drain = startDrain(jobs)
    await expectDrained(drain.state)
    await drain.settled

    // Returned BECAUSE of the park, not because the job had finished — the
    // distinction a drain that simply stopped waiting would blur.
    expect(jobs.parkedSize).toBe(1)
    expect(jobs.size).toBe(1)

    external.open()
    await vi.waitFor(() => expect(jobs.size).toBe(0), {timeout: 5_000, interval: 10})
  })

  it('awaits the jobs that are still progressing while another is parked', async () => {
    const jobs = new PendingIdleJobs(immediate)
    const external = gate()
    const work = gate()
    jobs.schedule(async (park: ParkHandle) => {
      const release = park()
      await external.promise
      release()
    })
    jobs.schedule(() => work.promise)

    const drain = startDrain(jobs)
    await vi.waitFor(() => expect(jobs.parkedSize).toBe(1), {timeout: 5_000, interval: 10})
    expect(drain.state.done).toBe(false)

    work.open()
    await expectDrained(drain.state)
    await drain.settled
  })

  it('awaits a job again once it releases its park', async () => {
    const jobs = new PendingIdleJobs(immediate)
    const external = gate()
    const rest = gate()
    jobs.schedule(async (park: ParkHandle) => {
      const release = park()
      await external.promise
      release()
      await rest.promise
    })

    const first = startDrain(jobs)
    await expectDrained(first.state)
    await first.settled

    external.open()
    await vi.waitFor(() => expect(jobs.parkedSize).toBe(0), {timeout: 5_000, interval: 10})

    const second = startDrain(jobs)
    await vi.waitFor(() => expect(jobs.size).toBe(1), {timeout: 5_000, interval: 10})
    expect(second.state.done).toBe(false)

    rest.open()
    await expectDrained(second.state)
    await second.settled
  })

  // Reported where the job settles, not through the drain: a barrier that raised
  // a job's error would have to decide which of several concurrent drains gets
  // it, and each family already catches what it can retry from.
  it('logs a failing job and leaves the drain to complete', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jobs = new PendingIdleJobs(immediate)
    const boom = new Error('job blew up')
    jobs.schedule(async () => { throw boom })

    await expect(jobs.drain()).resolves.toBeUndefined()
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('deferred job failed'), boom)
    expect(jobs.size).toBe(0)
  })

  it('releases a park at most once, however many times the job calls it', async () => {
    const jobs = new PendingIdleJobs(immediate)
    const external = gate()
    jobs.schedule(async (park: ParkHandle) => {
      const release = park()
      release()
      release()
      await external.promise
    })

    await vi.waitFor(() => expect(jobs.parkedSize).toBe(0), {timeout: 5_000, interval: 10})
    const drain = startDrain(jobs)
    expect(drain.state.done).toBe(false)

    external.open()
    await expectDrained(drain.state)
    await drain.settled
  })
})
