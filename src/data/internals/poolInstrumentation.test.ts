// @vitest-environment node
/**
 * Adapter-level occupancy counting.
 *
 * Built on the LIBRARY'S OWN `DBAdapterDefaultMixin` rather than a hand-written
 * adapter, because the coverage claim in `poolInstrumentation.ts` is a claim
 * about that mixin: intercepting `readLock`/`writeLock` counts every call only
 * because every other method is implemented in terms of them. A fake adapter
 * that merely behaved that way would pin our belief about PowerSync instead of
 * PowerSync. The stack itself is `@/data/test/fakePowerSyncStack`, shared with
 * the timing tests so there is one definition of what production looks like.
 */
import type { DBAdapter, LockContext } from '@powersync/common'
import { describe, expect, it } from 'vitest'
import { instrumentAdapter, instrumentOpenFactory } from './poolInstrumentation'
import { DbContention } from './timingMetrics'
import { makeFakeAdapter } from '@/data/test/fakePowerSyncStack'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const instrumented = () => {
  const pool = new DbContention()
  const {adapter, locks, sql} = makeFakeAdapter()
  return {db: instrumentAdapter(adapter, pool), pool, locks, sql, raw: adapter}
}

describe('the premise: every adapter method funnels through the two locks', () => {
  // If this fails after a PowerSync upgrade, `instrumentAdapter` has stopped
  // covering whatever method changed — silently, as an under-count. The fix is
  // to intercept the new path too, not to relax this test.
  it.each([
    ['getAll', (d: DBAdapter) => d.getAll('SELECT 1'), 'read'],
    ['getOptional', (d: DBAdapter) => d.getOptional('SELECT 1'), 'read'],
    ['get', (d: DBAdapter) => d.get('SELECT 1'), 'read'],
    ['execute', (d: DBAdapter) => d.execute('UPDATE x'), 'write'],
    ['executeRaw', (d: DBAdapter) => d.executeRaw('UPDATE x'), 'write'],
    ['executeBatch', (d: DBAdapter) => d.executeBatch('UPDATE x', [[1]]), 'write'],
    ['readTransaction', (d: DBAdapter) => d.readTransaction(async (tx) => tx.getAll('SELECT 1')), 'read'],
    ['writeTransaction', (d: DBAdapter) => d.writeTransaction(async (tx) => tx.execute('UPDATE x')), 'write'],
  ])('%s takes a %s lock and is counted once', async (_name, call, kind) => {
    const {db, pool, locks} = instrumented()
    await call(db)
    expect(locks).toEqual([kind])
    expect(pool.snapshot().calls).toBe(1)
  })
})

describe('instrumentAdapter', () => {
  it('counts a call that had the pool to itself as uncontended', async () => {
    const {db, pool} = instrumented()
    await db.getAll('SELECT 1')
    const s = pool.snapshot()
    expect(s.calls).toBe(1)
    expect(s.maxDepth).toBe(1)
    expect(s.uncontendedCalls).toBe(1)
    expect(s.uncontendedRead.calls).toBe(1)
  })

  it('keeps the read that found an empty pool and drops the one that arrived after it', async () => {
    const {db, pool} = instrumented()
    await Promise.all([db.getAll('SELECT 1'), db.getAll('SELECT 2')])
    const s = pool.snapshot()
    expect(s.calls).toBe(2)
    expect(s.maxDepth).toBe(2)
    expect(s.concurrentIssues).toBe(1)
    expect(s.uncontendedRead.calls).toBe(1)
  })

  it('keeps an uncontended WRITE out of the read reservoir but counts it as a call', async () => {
    const {db, pool} = instrumented()
    await db.execute('UPDATE x')
    const s = pool.snapshot()
    expect(s.uncontendedCalls).toBe(1)
    expect(s.uncontendedRead.calls).toBe(0)
  })

  it('does not count a transaction\'s inner SQL as competing with the transaction', async () => {
    const {db, pool} = instrumented()
    await db.writeTransaction(async (tx) => {
      await tx.getAll('SELECT 1 inside tx')
      await tx.execute('UPDATE inside tx')
    })
    const s = pool.snapshot()
    // One connection, held once. The inner statements run inside the
    // transaction's own lock; counting them again would report a connection
    // competing with itself.
    expect(s.calls).toBe(1)
    expect(s.maxDepth).toBe(1)
  })

  it('holds the pool for as long as the lock callback runs, not until the promise is handed back', async () => {
    const {db, pool} = instrumented()
    let depthDuringLock = -1
    await db.writeLock(async () => {
      await sleep(2)
      depthDuringLock = pool.snapshot().maxDepth
      // A read issued while the lock is held finds the pool occupied.
      await db.getAll('SELECT 1')
    })
    expect(depthDuringLock).toBe(1)
    expect(pool.snapshot().maxDepth).toBe(2)
    expect(pool.snapshot().uncontendedRead.calls).toBe(0)
  })

  it('releases the connection when a call throws', async () => {
    const pool = new DbContention()
    const boom = async () => { await sleep(1); throw new Error('boom') }
    const adapter = {
      readLock: boom, writeLock: boom, name: 'x',
    } as unknown as DBAdapter
    const db = instrumentAdapter(adapter, pool)
    await expect(db.readLock(async () => 1)).rejects.toThrow('boom')
    await expect(db.readLock(async () => 1)).rejects.toThrow('boom')
    const s = pool.snapshot()
    expect(s.calls).toBe(2)
    // Never left occupied: the second call still found the pool empty.
    expect(s.maxDepth).toBe(1)
    expect(s.uncontendedCalls).toBe(2)
  })

  it('leaves the rest of the adapter surface alone', async () => {
    const {db, raw} = instrumented()
    expect(db.name).toBe('fake.db')
    expect(typeof db.refreshSchema).toBe('function')
    expect(db instanceof (raw.constructor as new () => unknown)).toBe(true)
    // Pins Proxy semantics rather than a clause of ours: a write through the
    // wrapper must land on the adapter, so a reader holding the original still
    // sees it. Free from the default `set` behaviour today, and this is what
    // catches a hand-written trap that drops the receiver later.
    ;(db as unknown as {marker?: string}).marker = 'set'
    expect((raw as unknown as {marker?: string}).marker).toBe('set')
  })

  it('forwards lock options untouched', async () => {
    const pool = new DbContention()
    const seen: unknown[] = []
    const adapter = {
      readLock: async <T>(fn: (tx: LockContext) => Promise<T>, options?: unknown) => {
        seen.push(options)
        return fn({} as LockContext)
      },
    } as unknown as DBAdapter
    await instrumentAdapter(adapter, pool).readLock(async () => 1, {timeoutMs: 1234})
    expect(seen).toEqual([{timeoutMs: 1234}])
  })
})

describe('instrumentOpenFactory', () => {
  it('instruments whatever the wrapped factory opens', async () => {
    const pool = new DbContention()
    const {adapter} = makeFakeAdapter()
    const factory = instrumentOpenFactory({openDB: () => adapter}, pool)
    await factory.openDB().getAll('SELECT 1')
    expect(pool.snapshot().calls).toBe(1)
  })
})

describe('an uninstrumented pool judges nothing', () => {
  // The failure this guards is silent and reads as a very quiet session: with
  // nothing calling `begin`, depth is permanently zero, so every read and every
  // window would be classified as having had the database to itself.
  it('reports no clean samples when no adapter feeds it', () => {
    const pool = new DbContention()
    expect(pool.observingPool()).toBe(false)
    expect(pool.closeWindow(pool.openWindow())).toBe(false)
  })

  it('judges windows once an adapter is instrumented', () => {
    const pool = new DbContention()
    instrumentAdapter(makeFakeAdapter().adapter, pool)
    expect(pool.observingPool()).toBe(true)
    expect(pool.closeWindow(pool.openWindow())).toBe(true)
  })
})
