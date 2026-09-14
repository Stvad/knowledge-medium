/**
 * Occupancy counting at the database boundary.
 *
 * `DbContention` answers "did this window have the pool to itself?", and that
 * answer is only as good as its coverage of who is ON the pool. Counting above
 * the adapter covers the calls that layer sees and nothing else, and several
 * things use these connections without passing it (#965).
 *
 * `DBAdapter` is where the database work actually happens, and PowerSync routes
 * everything through it: `AbstractPowerSyncDatabase.getAll` / `get` /
 * `execute` / `readLock` / `writeTransaction` and its own internals — schema
 * load, version probe, `getUploadQueueStats` — all delegate to
 * `this.database.*`. So does anything holding the raw handle, which is the case
 * the proxy could not fix even in principle: `getUploadQueueStats` is
 * PowerSync's own method, and its reads never pass a wrapper placed above it.
 *
 * ONE PAIR OF METHODS COVERS ALL OF IT. `DBAdapterDefaultMixin` implements
 * every data method in terms of `readLock` / `writeLock`, so intercepting those
 * two counts each call exactly once and leaves the rest of the surface
 * untouched. That is a property of the library, not of our code, so
 * `poolInstrumentation.test.ts` pins it against the real exported mixin: an
 * upgrade that gives some method its own connection path would otherwise make
 * this file silently under-count.
 *
 * WHAT THIS STILL CANNOT SEE, and no in-tab instrument can:
 *   - the sync engine. With `enableMultiTabs`, PowerSync runs it in a
 *     SharedWorker which calls `shareConnection()` to get a MessagePort and
 *     builds its OWN client against the database worker. It uses these
 *     connections without passing this adapter. `watchSyncOccupancy` remains
 *     the only signal about it, on its own poor terms.
 *   - other tabs. The connections are per-database, not per-tab, and a second
 *     tab of the same workspace has its own adapter and its own counters.
 *
 * Both are the same shape: the pool is shared ACROSS contexts and these
 * counters live in one of them. That bounds what this metric can ever claim,
 * which is why the classification is worded as "nothing THIS CAN SEE was
 * competing" rather than as a guarantee.
 */
import type { DBAdapter, DBLockOptions, LockContext, SQLOpenFactory } from '@powersync/common'
import type { DbContention } from './timingMetrics.js'

/** The two methods every other one funnels through. */
type Lock = <T>(fn: (tx: LockContext) => Promise<T>, options?: DBLockOptions) => Promise<T>

/**
 * Return `adapter` with its connection acquisitions counted into `pool`.
 *
 * A Proxy rather than a subclass or a delegating object, and that is
 * load-bearing: the mixin's `getAll` reaches its connection as `this.readLock`,
 * so the interception only applies if `this` is the wrapper. A delegate that
 * forwarded `getAll` to the inner adapter would run the inner `readLock` and
 * count nothing.
 *
 * Only `get` is trapped. A `set` trap would be redundant — the default already
 * defines the property on the target, so the adapter's own writes reach it and
 * stay visible to anything holding the original — and adding one that forgot
 * the receiver would be how that stops being true.
 */
export const instrumentAdapter = (adapter: DBAdapter, pool: DbContention): DBAdapter => {
  pool.markPoolObserved()
  const held = async <T>(kind: 'read' | 'write', take: () => Promise<T>): Promise<T> => {
    const ticket = pool.begin()
    try {
      // AWAITED, not returned: a bare `return take()` runs the `finally` when
      // the promise is handed back, and the connection is held for as long as
      // it is PENDING. Releasing there reports the pool free for the whole
      // operation this exists to observe.
      return await take()
    } finally {
      pool.end(ticket, kind)
    }
  }

  // Called as methods ON the adapter, not through a looked-up reference: the
  // real implementation reaches its connections through `this`.
  const overrides: Record<'readLock' | 'writeLock', Lock> = {
    readLock: (fn, options) => held('read', () => adapter.readLock(fn, options)),
    writeLock: (fn, options) => held('write', () => adapter.writeLock(fn, options)),
  }

  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'readLock' || prop === 'writeLock') return overrides[prop]
      // UNBOUND, and no receiver. Unbound so a method called through this proxy
      // runs with `this` set to it, which is what routes the mixin's `getAll`
      // into the interception above. No receiver so an accessor still reads the
      // real adapter's own state rather than resolving back through here.
      return Reflect.get(target, prop)
    },
  }) as DBAdapter
}

/**
 * Wrap an open factory so the adapter it opens is instrumented.
 *
 * PowerSync accepts a `SQLOpenFactory` structurally (`isSQLOpenFactory` tests
 * for `openDB`), so this needs no knowledge of which factory it wraps and
 * changes nothing about how the database is opened.
 */
export const instrumentOpenFactory = (
  inner: SQLOpenFactory,
  pool: DbContention,
): SQLOpenFactory => ({
  openDB: () => instrumentAdapter(inner.openDB(), pool),
})
