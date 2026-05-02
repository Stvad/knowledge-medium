// @vitest-environment node
/**
 * Unit tests for the timing-metrics primitives. End-to-end wiring
 * through `repo.metrics()` lives in repoLifecycle.test.ts; this file
 * pins the building blocks: ring-buffer windowing, percentile
 * computation, and the DbMetrics / QueryMetrics aggregators.
 */

import { describe, expect, it } from 'vitest'
import {
  DbMetrics,
  QueryMetrics,
  TimingReservoir,
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
    m.record('core.subtree', 12)
    m.record('core.subtree', 18)
    m.record('plugin:tasks/dueSoon', 4)
    const s = m.snapshot()
    expect(Object.keys(s).sort()).toEqual(['core.subtree', 'plugin:tasks/dueSoon'])
    expect(s['core.subtree'].calls).toBe(2)
    expect(s['core.subtree'].minMs).toBe(12)
    expect(s['core.subtree'].maxMs).toBe(18)
    expect(s['plugin:tasks/dueSoon'].calls).toBe(1)
  })

  it('reset() drops empty reservoirs entirely (long-running session does not leak)', () => {
    const m = new QueryMetrics()
    m.record('core.foo', 1)
    expect(Object.keys(m.snapshot())).toContain('core.foo')
    m.reset()
    expect(Object.keys(m.snapshot())).toEqual([])
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
