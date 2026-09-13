// @vitest-environment node
/**
 * Unit tests for the timing-metrics primitives. End-to-end wiring
 * through `repo.metrics()` lives in repoLifecycle.test.ts; this file
 * pins the building blocks: ring-buffer windowing, percentile
 * computation, and the DbMetrics / QueryMetrics aggregators.
 */

import { describe, expect, it } from 'vitest'
import {
  DbContention,
  DbMetrics,
  QueryMetrics,
  TimingReservoir,
  contentionFor,
  wrapDbWithMetrics,
} from './timingMetrics'

describe('TimingReservoir', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new TimingReservoir(0)).toThrow()
    expect(() => new TimingReservoir(-1)).toThrow()
  })

  it('returns a zero snapshot when no samples have been recorded', () => {
    const r = new TimingReservoir(8)
    const s = r.snapshot()
    expect(s.calls).toBe(0)
    expect(s.sampleCount).toBe(0)
    expect(s.meanMs).toBe(0)
    expect(s.p50Ms).toBe(0)
    expect(s.p95Ms).toBe(0)
    expect(s.minMs).toBe(0)
    expect(s.maxMs).toBe(0)
    expect(s.totalMs).toBe(0)
  })

  it('computes mean/p50/p95/p99/min/max over the live samples', () => {
    const r = new TimingReservoir(16)
    for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) r.record(ms)
    const s = r.snapshot()
    expect(s.calls).toBe(10)
    expect(s.sampleCount).toBe(10)
    expect(s.minMs).toBe(10)
    expect(s.maxMs).toBe(100)
    expect(s.meanMs).toBeCloseTo(55, 5)
    // p50 of 10 samples → index Math.floor(10 * 0.5) = 5, sorted[5] = 60.
    // (Linear-interpolating implementations would give 55; we use a
    // simple nearest-rank rule because the harness is for "is this
    // 10ms or 100ms" decisions, not statistical rigor.)
    expect(s.p50Ms).toBe(60)
    expect(s.p95Ms).toBe(100)
    expect(s.p99Ms).toBe(100)
  })

  it('keeps only the most-recent capacity samples for percentile windowing; calls counts every record', () => {
    const r = new TimingReservoir(4)
    for (const ms of [1, 2, 3, 4, 5, 6, 7, 8]) r.record(ms)
    const s = r.snapshot()
    // calls is unbounded — counts every record() call.
    expect(s.calls).toBe(8)
    // sampleCount caps at capacity.
    expect(s.sampleCount).toBe(4)
    // The retained window is the last 4: {5,6,7,8}; min/max reflect
    // the window, not lifetime extremes.
    expect(s.minMs).toBe(5)
    expect(s.maxMs).toBe(8)
    expect(s.meanMs).toBeCloseTo(6.5, 5)
    // Lifetime sum still tracked (1+2+...+8 = 36).
    expect(s.totalMs).toBe(36)
  })

  it('returns a frozen snapshot independent of subsequent writes', () => {
    const r = new TimingReservoir(8)
    r.record(10)
    const before = r.snapshot()
    expect(Object.isFrozen(before)).toBe(true)
    expect(() => {
      // @ts-expect-error frozen at runtime
      before.calls = 999
    }).toThrow()
    r.record(20)
    expect(before.calls).toBe(1) // unchanged
    expect(r.snapshot().calls).toBe(2)
  })

  it('reset() zeros every counter and the buffer', () => {
    const r = new TimingReservoir(4)
    for (const ms of [10, 20, 30, 40, 50]) r.record(ms)
    expect(r.snapshot().calls).toBe(5)
    r.reset()
    const s = r.snapshot()
    expect(s.calls).toBe(0)
    expect(s.sampleCount).toBe(0)
    expect(s.totalMs).toBe(0)
  })
})

describe('DbMetrics', () => {
  it('exposes one TimingReservoir per method; snapshot is frozen', () => {
    const m = new DbMetrics()
    m.getAll.record(5)
    m.execute.record(2)
    m.writeTransaction.record(20)
    const s = m.snapshot()
    expect(Object.isFrozen(s)).toBe(true)
    expect(s.getAll.calls).toBe(1)
    expect(s.execute.calls).toBe(1)
    expect(s.writeTransaction.calls).toBe(1)
    // Buckets that didn't see traffic have a zero snapshot.
    expect(s.getOptional.calls).toBe(0)
    expect(s.get.calls).toBe(0)
  })

  it('reset() clears every bucket', () => {
    const m = new DbMetrics()
    m.getAll.record(5)
    m.writeTransaction.record(20)
    m.reset()
    const s = m.snapshot()
    expect(s.getAll.calls).toBe(0)
    expect(s.writeTransaction.calls).toBe(0)
  })
})

describe('QueryMetrics', () => {
  it('lazily creates per-name reservoirs; unused names absent from snapshot', () => {
    const m = new QueryMetrics()
    m.record('core.subtree', 12, true)
    m.record('core.subtree', 18, true)
    m.record('plugin:tasks/dueSoon', 4, true)
    const s = m.snapshot()
    expect(Object.keys(s).sort()).toEqual(['core.subtree', 'plugin:tasks/dueSoon'])
    expect(s['core.subtree'].calls).toBe(2)
    expect(s['core.subtree'].minMs).toBe(12)
    expect(s['core.subtree'].maxMs).toBe(18)
    expect(s['plugin:tasks/dueSoon'].calls).toBe(1)
  })

  it('keeps uncontended resolves in their own reservoir as well as the shared one', () => {
    const m = new QueryMetrics()
    m.record('core.ancestors', 5, true)
    m.record('core.ancestors', 600, false)
    m.record('core.ancestors', 7, true)
    const s = m.snapshot()['core.ancestors']
    // Every resolve is still counted — the queued one is reported, not dropped.
    expect(s.calls).toBe(3)
    expect(s.maxMs).toBe(600)
    // ...but the comparable figure sees only the two that ran unopposed, so a
    // session that fanned out more does not read as a slower data layer.
    expect(s.uncontended.calls).toBe(2)
    expect(s.uncontended.maxMs).toBe(7)
  })

  it('reset() drops empty reservoirs entirely (long-running session does not leak)', () => {
    const m = new QueryMetrics()
    m.record('core.foo', 1, true)
    expect(Object.keys(m.snapshot())).toContain('core.foo')
    m.reset()
    expect(Object.keys(m.snapshot())).toEqual([])
  })
})

describe('DbContention', () => {
  /** Drives overlap deterministically: every begin/end reads this clock. */
  const atClock = () => {
    let t = 0
    const pool = new DbContention(() => t)
    return {pool, set: (ms: number) => { t = ms }}
  }

  it('classifies a call that had the pool to itself as uncontended', () => {
    const {pool, set} = atClock()
    const ticket = pool.begin()
    set(4)
    expect(pool.end(ticket, 'read')).toBe(4)
    const s = pool.snapshot()
    expect(s.calls).toBe(1)
    expect(s.uncontendedCalls).toBe(1)
    expect(s.uncontendedRead.calls).toBe(1)
    expect(s.uncontendedRead.maxMs).toBe(4)
    expect(s.maxDepth).toBe(1)
  })

  it('keeps the call that took an empty pool and drops the one that arrived after', () => {
    const {pool, set} = atClock()
    const first = pool.begin()
    set(1)
    const second = pool.begin()
    set(10)
    pool.end(second, 'read')
    set(12)
    pool.end(first, 'read')
    const s = pool.snapshot()
    expect(s.calls).toBe(2)
    expect(s.concurrentIssues).toBe(1)
    expect(s.maxDepth).toBe(2)
    // The late arrival queued behind the early one. The early one waited for
    // nothing — what arrives afterwards lines up behind it, so its 12ms is its
    // own service time. Dropping it too would censor calls in proportion to how
    // long they ran, which is a bias against exactly the slow tail the
    // percentiles are for.
    expect(s.uncontendedCalls).toBe(1)
    expect(s.uncontendedRead.calls).toBe(1)
    expect(s.uncontendedRead.maxMs).toBe(12)
  })

  it('still judges an OBSERVATION WINDOW on its whole life, not just its start', () => {
    const {pool, set} = atClock()
    // Unlike a single call, a resolve issues reads over time: one that opens on
    // an idle pool can still have its later reads queue behind traffic that
    // arrived after it started. A resolve beginning just before a burst is
    // billed for the burst, and that is the sample that must not be called
    // clean.
    const window = pool.openWindow()
    set(1)
    const a = pool.begin()
    const b = pool.begin()
    set(10)
    pool.end(b, 'read')
    pool.end(a, 'read')
    expect(pool.closeWindow(window)).toBe(false)
  })

  it('counts busy time as the union of in-flight intervals, not the sum of durations', () => {
    const {pool, set} = atClock()
    const first = pool.begin()
    set(1)
    const second = pool.begin()
    set(10)
    pool.end(first, 'read')
    set(12)
    pool.end(second, 'read')
    // Durations sum to 10 + 11 = 21 across an interval that is only 12ms long.
    // Busy time is the interval; the excess is exactly the overlap that makes
    // a per-caller wall-clock unusable on its own.
    expect(pool.snapshot().busyMs).toBe(12)
  })

  it('reports the pool busy while a call is still open', () => {
    const {pool, set} = atClock()
    pool.begin()
    set(7)
    expect(pool.snapshot().busyMs).toBe(7)
  })

  it('excludes windows that a coalescer served shared work across', () => {
    const {pool, set} = atClock()
    // Exactly the shape of N resolves awaiting one batched statement: the pool
    // is idle for each of them, and their identical wall-clocks are ONE
    // observation. Only the coalescer knows, so only it can say.
    const first = pool.openWindow()
    const second = pool.openWindow()
    set(3)
    pool.noteSharedWork()
    set(9)
    expect(pool.closeWindow(first)).toBe(false)
    expect(pool.closeWindow(second)).toBe(false)
  })

  it('lets a lone observer keep its batch: shared work needs a second window', () => {
    const {pool, set} = atClock()
    // `core.manyAncestors` asks the batcher for every id it was given, inside
    // ONE resolve. That batch is its own work, not work shared with another
    // observation — billing it as shared would bar the query from ever being
    // measured cleanly.
    const only = pool.openWindow()
    set(3)
    pool.noteSharedWork()
    set(9)
    expect(pool.closeWindow(only)).toBe(true)
  })

  it('judges a window opened while a call was already in flight as contended', () => {
    const {pool, set} = atClock()
    const inFlight = pool.begin()
    const window = pool.openWindow()
    set(5)
    pool.end(inFlight, 'read')
    expect(pool.closeWindow(window)).toBe(false)
  })

  it('refuses to judge a window that spans a reset, however the counters land', () => {
    const {pool, set} = atClock()
    // The counters are zeroed under the open window and then climb back through
    // the values it holds. Without a span identity they compare EQUAL and a
    // thoroughly contended window reads as clean.
    const contended = pool.begin()
    set(1)
    const other = pool.begin()
    pool.end(other, 'read')
    pool.end(contended, 'read')
    const window = pool.openWindow()
    set(2)
    pool.reset()
    const a = pool.begin()
    const b = pool.begin()
    set(4)
    pool.end(b, 'read')
    pool.end(a, 'read')
    expect(pool.closeWindow(window)).toBe(false)
  })

  it('keeps the uncontended count consistent with the call count across a reset', () => {
    const {pool, set} = atClock()
    const spanning = pool.begin()
    pool.reset()
    set(5)
    pool.end(spanning, 'read')
    const s = pool.snapshot()
    // A call that began in the previous span is not one of this span's calls,
    // so it must not be one of this span's uncontended ones either — a
    // snapshot reading `calls: 0` beside `uncontendedCalls: 1` describes a
    // measurement that did not happen here.
    expect(s.calls).toBe(0)
    expect(s.uncontendedCalls).toBe(0)
  })

  it('treats bracketed sync work as occupying the pool', () => {
    const {pool, set} = atClock()
    // The sync engine connects to the raw database before the Repo wraps it, so
    // its reads and writes never reach `begin`. They are on the same
    // connections regardless, and a read queued behind them is not a clean
    // measurement of anything.
    pool.beginForeign()
    const ticket = pool.begin()
    set(20)
    pool.end(ticket, 'read')
    pool.endForeign()
    const s = pool.snapshot()
    expect(s.uncontendedRead.calls).toBe(0)
    expect(s.maxDepth).toBe(2)
    expect(s.foreignIntervals).toBe(1)
    // Occupancy only: sync work is not ours to report as a db call.
    expect(s.calls).toBe(1)
  })

  it('dirties a window on sync arrival without counting it as a call we issued', () => {
    const {pool, set} = atClock()
    const window = pool.openWindow()
    const ticket = pool.begin()
    set(1)
    pool.beginForeign()
    set(5)
    pool.endForeign()
    pool.end(ticket, 'read')

    // Sync joining mid-window disturbs it exactly as one of our own calls
    // would — for the question a window asks, the two are the same event.
    expect(pool.closeWindow(window)).toBe(false)
    const s = pool.snapshot()
    // But the REPORTED counter says "calls this Repo issued into an occupied
    // pool", and sync issued none of them. Folding it in lets this exceed
    // `calls` and stop meaning what it says.
    expect(s.concurrentIssues).toBe(0)
    expect(s.calls).toBe(1)
  })

  it('reports whether sync was observable at all', () => {
    const {pool} = atClock()
    // Zero foreign intervals is ambiguous — a quiet session and a session whose
    // status channel never reached us look identical. This names the difference.
    expect(pool.snapshot().syncObserved).toBe(false)
    pool.markSyncObserved()
    expect(pool.snapshot().syncObserved).toBe(true)
  })

  it('keeps uncontended WRITE timings out of the read reservoir', () => {
    const {pool, set} = atClock()
    const ticket = pool.begin()
    set(30)
    pool.end(ticket, 'write')
    const s = pool.snapshot()
    // Counted as a call that ran unopposed, but a write serialises on the
    // writer connection whatever else is happening, so "unopposed" does not
    // mean for it what it means for a read.
    expect(s.uncontendedCalls).toBe(1)
    expect(s.uncontendedRead.calls).toBe(0)
  })

  it('reset() starts busy time over, without back-dating it to a call that began before', () => {
    const {pool, set} = atClock()
    pool.begin()
    set(10)
    pool.reset()
    set(15)
    // 5, not 15: the span begins at the reset. Carrying the open interval's
    // original start across would charge the new span with time it did not
    // cover — and a `resetMetrics()` taken to mark a baseline is exactly when
    // a long-running call is likely to be open.
    expect(pool.snapshot().busyMs).toBe(5)
  })

  it('reset() keeps in-flight state so a call spanning it still classifies', () => {
    const {pool, set} = atClock()
    const spanning = pool.begin()
    set(2)
    pool.reset()
    set(5)
    const during = pool.begin()
    set(6)
    pool.end(during, 'read')
    set(8)
    pool.end(spanning, 'read')
    const s = pool.snapshot()
    // Two ends against a zeroed counter must not drive depth below zero: a
    // negative in-flight count would report the pool idle and mark every later
    // call uncontended.
    expect(s.maxDepth).toBe(2)
    expect(s.uncontendedCalls).toBe(0)
    expect(s.calls).toBe(1)
  })
})

describe('wrapDbWithMetrics', () => {
  // Build a minimal fake PowerSyncDb that resolves after a short delay
  // so we get measurable timings (single-digit ms is fine — we only
  // assert that calls were recorded and ordering is sane).
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  const makeFakeDb = () => ({
    calls: [] as string[],
    writeTransaction: async <R>(fn: (tx: unknown) => Promise<R>): Promise<R> => {
      const tx = {
        execute: async (sql: string) => { await sleep(1); return {sql} },
        getAll: async <T>(sql: string) => { await sleep(1); return [{sql}] as unknown as T[] },
        getOptional: async <T>(sql: string) => { await sleep(1); return {sql} as unknown as T },
        get: async <T>(sql: string) => { await sleep(1); return {sql} as unknown as T },
      }
      await sleep(2)
      return fn(tx)
    },
    getAll: async <T>(sql: string) => { await sleep(1); return [{sql}] as unknown as T[] },
    getOptional: async <T>(sql: string) => { await sleep(1); return {sql} as unknown as T },
    get: async <T>(sql: string) => { await sleep(1); return {sql} as unknown as T },
    execute: async (sql: string) => { await sleep(1); return {sql} },
  })

  it('records every read-method call into its respective bucket', async () => {
    const fake = makeFakeDb()
    const metrics = new DbMetrics()
    const wrapped = wrapDbWithMetrics(fake, metrics) as ReturnType<typeof makeFakeDb>
    await wrapped.getAll('SELECT 1')
    await wrapped.getOptional('SELECT 2')
    await wrapped.get('SELECT 3')
    await wrapped.execute('UPDATE x')
    const s = metrics.snapshot()
    expect(s.getAll.calls).toBe(1)
    expect(s.getOptional.calls).toBe(1)
    expect(s.get.calls).toBe(1)
    expect(s.execute.calls).toBe(1)
    expect(s.getAll.minMs).toBeGreaterThan(0)
  })

  it('records writeTransaction wall time AND the inner LockContext SQL calls', async () => {
    const fake = makeFakeDb()
    const metrics = new DbMetrics()
    const wrapped = wrapDbWithMetrics(fake, metrics) as ReturnType<typeof makeFakeDb>
    await wrapped.writeTransaction(async (tx) => {
      const t = tx as {
        getAll: (sql: string) => Promise<unknown>
        execute: (sql: string) => Promise<unknown>
      }
      await t.getAll('SELECT 1 inside tx')
      await t.execute('UPDATE inside tx')
    })
    const s = metrics.snapshot()
    expect(s.writeTransaction.calls).toBe(1)
    // Inner calls timed too.
    expect(s.getAll.calls).toBe(1)
    expect(s.execute.calls).toBe(1)
    // Wall-clock writeTransaction sample includes the outer 2ms +
    // inner 1ms + 1ms delays. Allow 1ms of slop for setTimeout
    // imprecision (we've observed 3.98ms on a 4ms minimum).
    expect(s.writeTransaction.maxMs).toBeGreaterThanOrEqual(3)
  })

  it('still records timing when the wrapped call throws', async () => {
    const metrics = new DbMetrics()
    const fail = async () => { await sleep(1); throw new Error('boom') }
    const failing = {
      writeTransaction: fail as unknown as <R>(fn: (tx: unknown) => Promise<R>) => Promise<R>,
      getAll: fail as unknown as <T>(sql: string, params?: unknown[]) => Promise<T[]>,
      getOptional: fail as unknown as <T>(sql: string, params?: unknown[]) => Promise<T | null>,
      get: fail as unknown as <T>(sql: string, params?: unknown[]) => Promise<T>,
      execute: fail as unknown as (sql: string, params?: unknown[]) => Promise<unknown>,
    }
    const wrapped = wrapDbWithMetrics(failing, metrics) as typeof failing
    await expect(wrapped.getAll('x')).rejects.toThrow('boom')
    await expect(wrapped.execute('y')).rejects.toThrow('boom')
    const s = metrics.snapshot()
    // Each failing call still produced a sample.
    expect(s.getAll.calls).toBe(1)
    expect(s.execute.calls).toBe(1)
  })

  it('keeps sequential reads and the first of an overlapping pair', async () => {
    const metrics = new DbMetrics()
    const wrapped = wrapDbWithMetrics(makeFakeDb(), metrics) as ReturnType<typeof makeFakeDb>
    await wrapped.getAll('SELECT 1')
    await wrapped.get('SELECT 2')
    expect(metrics.contention.snapshot().uncontendedRead.calls).toBe(2)
    await Promise.all([wrapped.getAll('SELECT 3'), wrapped.getAll('SELECT 4')])
    const s = metrics.contention.snapshot()
    expect(s.calls).toBe(4)
    expect(s.maxDepth).toBe(2)
    // 3, not 4: of the concurrent pair only the one that found the pool empty
    // is a measurement of how fast the database is. The other waited for it.
    expect(s.uncontendedRead.calls).toBe(3)
  })

  it('does not count a transaction\'s inner SQL as competing with the transaction', async () => {
    const metrics = new DbMetrics()
    const wrapped = wrapDbWithMetrics(makeFakeDb(), metrics) as ReturnType<typeof makeFakeDb>
    await wrapped.writeTransaction(async (tx) => {
      await (tx as {getAll: (sql: string) => Promise<unknown>}).getAll('SELECT 1 inside tx')
    })
    const s = metrics.contention.snapshot()
    // One connection was held, once — the inner read runs inside the
    // transaction's own ticket, and counting it again would report the
    // connection competing with itself.
    expect(s.calls).toBe(1)
    expect(s.maxDepth).toBe(1)
  })

  /** A db that reports sync activity the way PowerSync does. */
  const syncingDb = (initial?: {downloading?: boolean; uploading?: boolean}) => {
    const base = makeFakeDb() as ReturnType<typeof makeFakeDb> & {
      currentStatus?: unknown
      registerListener?: unknown
    }
    let notify: ((s: unknown) => void) | undefined
    base.currentStatus = initial ? {dataFlowStatus: initial} : undefined
    base.registerListener = (l: {statusChanged?: (s: unknown) => void}) => {
      notify = l.statusChanged
      return () => {}
    }
    return {
      base,
      set: (flow: {downloading?: boolean; uploading?: boolean}) =>
        notify?.({dataFlowStatus: flow}),
    }
  }

  it('treats a read taken during sync as contended', async () => {
    const {base, set} = syncingDb()
    const metrics = new DbMetrics()
    const wrapped = wrapDbWithMetrics(base, metrics) as ReturnType<typeof makeFakeDb>
    await wrapped.getAll('before sync')
    expect(metrics.contention.snapshot().uncontendedRead.calls).toBe(1)

    set({downloading: true})
    await wrapped.getAll('during sync')
    set({downloading: false})
    await wrapped.getAll('after sync')

    const s = metrics.contention.snapshot()
    // The sync engine is on the same connections but never calls through this
    // proxy, so without the bracket the middle read would look like a clean
    // measurement of an idle database.
    expect(s.uncontendedRead.calls).toBe(2)
    expect(s.foreignIntervals).toBe(1)
    expect(s.syncObserved).toBe(true)
  })

  it('brackets an upload as well as a download', async () => {
    const {base, set} = syncingDb()
    const metrics = new DbMetrics()
    const wrapped = wrapDbWithMetrics(base, metrics) as ReturnType<typeof makeFakeDb>
    set({uploading: true})
    await wrapped.getAll('during upload')
    expect(metrics.contention.snapshot().uncontendedRead.calls).toBe(0)
  })

  it('brackets sync already in progress when the Repo is built', async () => {
    const {base} = syncingDb({downloading: true})
    const metrics = new DbMetrics()
    const wrapped = wrapDbWithMetrics(base, metrics) as ReturnType<typeof makeFakeDb>
    await wrapped.getAll('during the sync that was already running')
    expect(metrics.contention.snapshot().uncontendedRead.calls).toBe(0)
  })

  it('opens one bracket per sync episode, however often the status repeats', async () => {
    const {base, set} = syncingDb()
    const metrics = new DbMetrics()
    const wrapped = wrapDbWithMetrics(base, metrics) as ReturnType<typeof makeFakeDb>
    // PowerSync republishes its status on every change, most of which do not
    // flip these flags. Bracketing each one would open occupancy that
    // never closes, and the pool would read as permanently busy for the rest of
    // the session — every later read contended, with no way back.
    set({downloading: true})
    set({downloading: true})
    set({downloading: true})
    set({downloading: false})
    await wrapped.getAll('after the episode')
    const s = metrics.contention.snapshot()
    expect(s.foreignIntervals).toBe(1)
    expect(s.uncontendedRead.calls).toBe(1)
  })

  it('says when sync is not observable at all', () => {
    const metrics = new DbMetrics()
    // A fake db with no status channel — and a local-only session, which has no
    // sync engine to watch. Zero foreign intervals means different things in
    // the two cases, and only this field separates them.
    wrapDbWithMetrics(makeFakeDb(), metrics)
    expect(metrics.contention.snapshot().syncObserved).toBe(false)
  })

  it('counts a raw write lock as holding the pool', async () => {
    const metrics = new DbMetrics()
    const base = makeFakeDb() as ReturnType<typeof makeFakeDb> & {writeLock?: unknown}
    // The SQLite export takes this lock directly and holds it across a
    // checkpoint and a copy of the whole database. Passing through untracked,
    // a read issued during one starts at depth zero and is recorded as having
    // had the pool to itself while it waits behind the export.
    // Acquires the connection BEFORE running the callback, as the real one
    // does. A fake that invokes it synchronously lets the read land before a
    // mistakenly-early release and reports clean either way.
    base.writeLock = async <R,>(fn: (tx: unknown) => Promise<R>): Promise<R> => {
      await sleep(1)
      return fn({})
    }
    const wrapped = wrapDbWithMetrics(base, metrics) as ReturnType<typeof makeFakeDb> & {
      writeLock: <R>(fn: (tx: unknown) => Promise<R>) => Promise<R>
    }

    let duringLock = 0
    await wrapped.writeLock(async () => {
      await wrapped.getAll('SELECT 1 during the export')
      duringLock = metrics.contention.snapshot().uncontendedRead.calls
    })

    expect(duringLock).toBe(0)
    expect(metrics.contention.snapshot().maxDepth).toBe(2)
    // And the lock is only released once its work is done, not when its promise
    // is handed over.
    expect(metrics.contention.snapshot().uncontendedRead.calls).toBe(0)
  })

  it('leaves a lock the database does not have absent rather than inventing it', () => {
    const metrics = new DbMetrics()
    const wrapped = wrapDbWithMetrics(makeFakeDb(), metrics) as Record<string, unknown>
    // A fake or a database without these must not suddenly appear to have them
    // — callers feature-detect the method before using it.
    expect(wrapped.writeLock).toBeUndefined()
  })

  it('exposes the tracker from the wrapped db, so a coalescer can reach it', () => {
    const metrics = new DbMetrics()
    const wrapped = wrapDbWithMetrics(makeFakeDb(), metrics)
    expect(contentionFor(wrapped)).toBe(metrics.contention)
    expect(contentionFor({})).toBeUndefined()
  })

  it('passes through non-timed methods (e.g. onChange, close) via the Proxy', () => {
    const metrics = new DbMetrics()
    let onChangeRegistered: unknown = null
    let closed = false
    const fake = {
      // None of the timed methods get called in this test.
      writeTransaction: async () => undefined as unknown,
      getAll: async () => [],
      getOptional: async () => null,
      get: async () => ({} as unknown),
      execute: async () => undefined as unknown,
      // Non-timed pass-through methods.
      onChange: (handler: unknown) => { onChangeRegistered = handler; return () => {} },
      close: () => { closed = true },
    }
    const wrapped = wrapDbWithMetrics(fake, metrics) as typeof fake
    const handler = {onChange: () => {}}
    const unsub = wrapped.onChange(handler)
    expect(typeof unsub).toBe('function')
    expect(onChangeRegistered).toBe(handler)
    wrapped.close()
    expect(closed).toBe(true)
  })
})
