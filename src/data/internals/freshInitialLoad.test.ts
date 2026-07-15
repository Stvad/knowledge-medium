import { describe, expect, it, vi } from 'vitest'
import { runFreshInitialLoad, type RetryScheduler } from './freshInitialLoad'

// Run scheduled retries synchronously (on the next microtask via the promise
// chain) so tests don't depend on real timers.
const syncSchedule: RetryScheduler = run => {
  run()
  return () => {}
}

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

describe('runFreshInitialLoad', () => {
  it('delivers the value when the first load succeeds', async () => {
    const onLoaded = vi.fn()
    const onError = vi.fn()
    runFreshInitialLoad(() => Promise.resolve('rows'), onLoaded, onError, {
      schedule: syncSchedule,
    })
    await flushMicrotasks()
    expect(onLoaded).toHaveBeenCalledExactlyOnceWith('rows')
    expect(onError).not.toHaveBeenCalled()
  })

  it('recovers from a transient failure within the retry budget', async () => {
    let calls = 0
    const loadFresh = vi.fn(() => {
      calls += 1
      return calls <= 2 ? Promise.reject(new Error('busy')) : Promise.resolve('ok')
    })
    const onLoaded = vi.fn()
    const onError = vi.fn()
    runFreshInitialLoad(loadFresh, onLoaded, onError, {schedule: syncSchedule})
    await flushMicrotasks()
    expect(loadFresh).toHaveBeenCalledTimes(3)
    expect(onLoaded).toHaveBeenCalledExactlyOnceWith('ok')
    expect(onError).not.toHaveBeenCalled()
  })

  it('surfaces the error only after exhausting the retry budget', async () => {
    const error = new Error('down')
    const loadFresh = vi.fn(() => Promise.reject(error))
    const onLoaded = vi.fn()
    const onError = vi.fn()
    runFreshInitialLoad(loadFresh, onLoaded, onError, {retries: 3, schedule: syncSchedule})
    await flushMicrotasks()
    // initial attempt + 3 retries
    expect(loadFresh).toHaveBeenCalledTimes(4)
    expect(onError).toHaveBeenCalledExactlyOnceWith(error)
    expect(onLoaded).not.toHaveBeenCalled()
  })

  it('cancel() suppresses a late success and any pending retry', async () => {
    let resolveLoad: (value: string) => void = () => {}
    const loadFresh = vi.fn(() => new Promise<string>(resolve => { resolveLoad = resolve }))
    const onLoaded = vi.fn()
    const onError = vi.fn()
    const cancel = runFreshInitialLoad(loadFresh, onLoaded, onError, {schedule: syncSchedule})
    cancel()
    resolveLoad('late')
    await flushMicrotasks()
    expect(onLoaded).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('cancel() suppresses a late failure and schedules no retry', async () => {
    // Mirror of the late-success case, but the in-flight load REJECTS after
    // cancel — exercising the error handler's cancelled-guard. Without it, a
    // cancelled load could still schedule a retry (or call onError) after
    // teardown.
    let rejectLoad: (error: unknown) => void = () => {}
    const loadFresh = vi.fn(() => new Promise<string>((_, reject) => { rejectLoad = reject }))
    const onLoaded = vi.fn()
    const onError = vi.fn()
    const cancel = runFreshInitialLoad(loadFresh, onLoaded, onError, {schedule: syncSchedule})
    cancel()
    rejectLoad(new Error('late'))
    await flushMicrotasks()
    expect(onError).not.toHaveBeenCalled()
    expect(onLoaded).not.toHaveBeenCalled()
    // No retry was scheduled after cancel — the single initial attempt stands.
    expect(loadFresh).toHaveBeenCalledTimes(1)
  })

  it('cancel() clears a pending retry so no further load is attempted', async () => {
    const loadFresh = vi.fn(() => Promise.reject(new Error('busy')))
    const onError = vi.fn()
    let pendingRetry: (() => void) | null = null
    const deferredSchedule: RetryScheduler = run => {
      pendingRetry = run
      return () => { pendingRetry = null }
    }
    const cancel = runFreshInitialLoad(loadFresh, vi.fn(), onError, {
      schedule: deferredSchedule,
    })
    await flushMicrotasks()
    // First attempt failed and a retry is pending but not yet run.
    expect(loadFresh).toHaveBeenCalledTimes(1)
    expect(pendingRetry).not.toBeNull()
    cancel()
    // cancel must clear the pending retry via the scheduler's canceller.
    expect(pendingRetry).toBeNull()
    await flushMicrotasks()
    expect(loadFresh).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })
})
