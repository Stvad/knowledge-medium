// @vitest-environment node
/**
 * BlockCache unit tests. The cache is the in-memory mirror of `blocks`
 * SQL state used by Block facades / hooks / TxEngine — it's a core
 * component of the data-layer redesign and tested in isolation here.
 *
 * Coverage:
 *   - Snapshot storage: get/has/require/set/delete + deep-freeze
 *   - Change detection: setSnapshot returns true on diff, false on
 *     fingerprint match
 *   - Subscriptions: fire on set + delete, dedupe on no-op set,
 *     unsubscribe stops firing
 *   - applyIfNewer (LWW): rejects arrivals whose updatedAt is
 *     older than the cached snapshot; accepts strictly newer. Both
 *     'sync' and 'hydrate' sources share the gate; the source label
 *     only routes per-bucket metric counters.
 *   - trackedIds: subscribed listener ids
 *   - dedupLoad: shares in-flight promise; restarts after resolve/reject
 *   - missing markers: markMissing notifies on first transition,
 *     clearMissing notifies, setSnapshot clears missing
 *
 * Replaces deleted `src/data/test/blockCache.test.ts` (legacy BlockData
 * shape used `childIds`/`createTime`/`updateTime`/`createdByUserId`).
 */

import { describe, expect, it, vi } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import type { BlockData } from '@/data/api'

const snap = (overrides: Partial<BlockData> = {}): BlockData => ({
  id: 'block-1',
  workspaceId: 'ws',
  parentId: null,
  orderKey: 'a0',
  content: '',
  properties: {},
  references: [],
  createdAt: 0,
  updatedAt: 0,
  userUpdatedAt: 0,
  createdBy: 'user',
  updatedBy: 'user',
  deleted: false,
  ...overrides,
})

describe('BlockCache snapshot storage', () => {
  it('returns undefined for unknown ids', () => {
    const cache = new BlockCache()
    expect(cache.getSnapshot('missing')).toBeUndefined()
    expect(cache.hasSnapshot('missing')).toBe(false)
  })

  it('throws from requireSnapshot when the id is unknown', () => {
    const cache = new BlockCache()
    expect(() => cache.requireSnapshot('missing'))
      .toThrowError('Block is not loaded yet: missing')
  })

  it('deep-freezes the stored snapshot so external mutation is blocked', () => {
    const cache = new BlockCache()
    const original = snap({content: 'hello', references: [{id: 'x', alias: 'x'}]})
    cache.setSnapshot(original)

    expect(() => { (original as {content: string}).content = 'mutated' }).toThrow()
    expect(() => { original.references.push({id: 'y', alias: 'y'}) }).toThrow()
    expect(cache.getSnapshot('block-1')?.content).toBe('hello')
  })
})

describe('BlockCache change detection', () => {
  it('returns true on first set and on differing content', () => {
    const cache = new BlockCache()
    expect(cache.setSnapshot(snap({content: 'a'}))).toBe(true)
    expect(cache.setSnapshot(snap({content: 'b'}))).toBe(true)
  })

  it('returns false when the incoming fingerprint matches the existing one', () => {
    const cache = new BlockCache()
    cache.setSnapshot(snap({content: 'a'}))
    expect(cache.setSnapshot(snap({content: 'a'}))).toBe(false)
  })

  it('returns false from deleteSnapshot when nothing was cached', () => {
    expect(new BlockCache().deleteSnapshot('missing')).toBe(false)
  })

  it('returns true from deleteSnapshot when the snapshot existed', () => {
    const cache = new BlockCache()
    cache.setSnapshot(snap())
    expect(cache.deleteSnapshot('block-1')).toBe(true)
    expect(cache.hasSnapshot('block-1')).toBe(false)
  })
})

describe('BlockCache subscriptions', () => {
  it('fires every subscribed listener on set', () => {
    const cache = new BlockCache()
    const a = vi.fn()
    const b = vi.fn()
    cache.subscribe('block-1', a)
    cache.subscribe('block-1', b)

    cache.setSnapshot(snap({content: 'first'}))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('does not fire listeners when the snapshot is unchanged', () => {
    const cache = new BlockCache()
    cache.setSnapshot(snap({content: 'a'}))
    const listener = vi.fn()
    cache.subscribe('block-1', listener)

    cache.setSnapshot(snap({content: 'a'}))
    expect(listener).not.toHaveBeenCalled()
  })

  it('fires listeners on delete', () => {
    const cache = new BlockCache()
    cache.setSnapshot(snap())
    const listener = vi.fn()
    cache.subscribe('block-1', listener)

    cache.deleteSnapshot('block-1')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not fire listeners on a no-op delete', () => {
    const cache = new BlockCache()
    const listener = vi.fn()
    cache.subscribe('block-1', listener)

    cache.deleteSnapshot('block-1')
    expect(listener).not.toHaveBeenCalled()
  })

  it('removes the listener on unsubscribe', () => {
    const cache = new BlockCache()
    const listener = vi.fn()
    const unsubscribe = cache.subscribe('block-1', listener)

    unsubscribe()
    cache.setSnapshot(snap({content: 'x'}))
    expect(listener).not.toHaveBeenCalled()
  })

  it('idempotent unsubscribe does not detach a fresh re-subscribe', () => {
    const cache = new BlockCache()
    const stale = vi.fn()
    const unsubA = cache.subscribe('block-1', stale)
    unsubA()
    const fresh = vi.fn()
    cache.subscribe('block-1', fresh)
    unsubA() // second call must not evict the new bucket
    cache.setSnapshot(snap({content: 'x'}))
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(stale).not.toHaveBeenCalled()
  })
})

describe('BlockCache applyIfNewer (LWW)', () => {
  it('accepts when nothing is cached', () => {
    const cache = new BlockCache()
    expect(cache.applyIfNewer(snap({content: 'fresh', updatedAt: 100}), 'sync')).toBe(true)
    expect(cache.getSnapshot('block-1')?.content).toBe('fresh')
  })

  it('rejects an older snapshot', () => {
    const cache = new BlockCache()
    cache.setSnapshot(snap({content: 'newer', updatedAt: 200}))
    expect(cache.applyIfNewer(snap({content: 'older', updatedAt: 100}), 'sync')).toBe(false)
    expect(cache.getSnapshot('block-1')?.content).toBe('newer')
  })

  it('accepts a strictly newer snapshot', () => {
    const cache = new BlockCache()
    cache.setSnapshot(snap({content: 'older', updatedAt: 100}))
    expect(cache.applyIfNewer(snap({content: 'newer', updatedAt: 200}), 'sync')).toBe(true)
    expect(cache.getSnapshot('block-1')?.content).toBe('newer')
  })

  it('rejects an equal-time snapshot (LWW gate is `<=`, not `<`)', () => {
    const cache = new BlockCache()
    cache.setSnapshot(snap({content: 'x', updatedAt: 100}))
    // Same-updatedAt-same-content is a no-op either way (was previously
    // a fingerprint-dedup no-op; now an LWW reject). The strict `<=`
    // exists so equal-updatedAt-DIFFERENT-content can't clobber the
    // cache via an in-flight sync read that overlapped a same-ms write
    // — covered by the test below.
    expect(cache.applyIfNewer(snap({content: 'x', updatedAt: 100}), 'sync')).toBe(false)
    expect(cache.getSnapshot('block-1')?.content).toBe('x')
  })

  it('rejects an equal-time snapshot with DIFFERENT content (clobber guard)', () => {
    const cache = new BlockCache()
    // Simulates: local commit lands with updatedAt=100, content='B'.
    // An in-flight sync read that captured content='A' at the same ms
    // arrives later — `<` would let it clobber, `<=` rejects.
    cache.setSnapshot(snap({content: 'B', updatedAt: 100}))
    expect(cache.applyIfNewer(snap({content: 'A', updatedAt: 100}), 'sync')).toBe(false)
    expect(cache.getSnapshot('block-1')?.content).toBe('B')
  })

  it('does not notify subscribers when an older snapshot is rejected', () => {
    const cache = new BlockCache()
    cache.setSnapshot(snap({content: 'newer', updatedAt: 200}))
    const listener = vi.fn()
    cache.subscribe('block-1', listener)
    cache.applyIfNewer(snap({content: 'older', updatedAt: 100}), 'sync')
    expect(listener).not.toHaveBeenCalled()
  })

  it('shares the LWW gate across sources but routes counters separately', () => {
    const cache = new BlockCache()
    cache.setSnapshot(snap({updatedAt: 100}))
    expect(cache.applyIfNewer(snap({updatedAt: 50}), 'hydrate')).toBe(false)
    expect(cache.applyIfNewer(snap({updatedAt: 50}), 'sync')).toBe(false)
    expect(cache.metrics.applyIfNewerHydrateRejected).toBe(1)
    expect(cache.metrics.applyIfNewerSyncRejected).toBe(1)
  })
})

describe('BlockCache applyFromSync (heal-aware sync write)', () => {
  it('force-applies an OLDER row when the cache still matches the pre-write disk row', () => {
    // The live shadow heal: cache holds a now-stamped default; the observer
    // applied the older server row to disk and passes the default as `before`.
    // Because the cache still equals `before`, the older `after` replaces it.
    const cache = new BlockCache()
    const staleDefault = snap({content: 'default', updatedAt: 9000})
    cache.setSnapshot(staleDefault)

    const healed = cache.applyFromSync(snap({content: 'real config', updatedAt: 3000}), staleDefault)

    expect(healed).toBe(true)
    expect(cache.getSnapshot('block-1')?.content).toBe('real config')
    expect(cache.metrics.applyFromSyncForced).toBe(1)
  })

  it('falls back to LWW (no clobber) when the cache has diverged from before', () => {
    // A local commit advanced the cache past `before` after the observer read
    // it. The older `after` must NOT clobber the newer local edit — fall back
    // to the LWW gate, which rejects it.
    const cache = new BlockCache()
    const before = snap({content: 'default', updatedAt: 9000})
    cache.setSnapshot(snap({content: 'local edit', updatedAt: 12000})) // cache moved on

    const out = cache.applyFromSync(snap({content: 'older server', updatedAt: 3000}), before)

    expect(out).toBe(false)
    expect(cache.getSnapshot('block-1')?.content).toBe('local edit')
    expect(cache.metrics.applyFromSyncForced).toBe(0)
  })

  it('falls back to LWW for a first-seen row (before is null)', () => {
    // No pre-write disk row: nothing to "match", so this is an ordinary
    // newer-wins sync write through the LWW gate.
    const cache = new BlockCache()
    const out = cache.applyFromSync(snap({content: 'fresh', updatedAt: 100}), null)
    expect(out).toBe(true)
    expect(cache.getSnapshot('block-1')?.content).toBe('fresh')
    expect(cache.metrics.applyFromSyncForced).toBe(0)
  })
})

describe('BlockCache trackedIds', () => {
  it('returns the set of subscribed ids', () => {
    const cache = new BlockCache()
    cache.subscribe('a', () => {})
    cache.subscribe('b', () => {})
    expect(cache.trackedIds()).toEqual(new Set(['a', 'b']))
  })

  it('drops an id once its last listener unsubscribes', () => {
    const cache = new BlockCache()
    const unsubscribe = cache.subscribe('a', () => {})
    cache.subscribe('b', () => {})
    unsubscribe()
    expect(cache.trackedIds()).toEqual(new Set(['b']))
  })
})

describe('BlockCache dedupLoad', () => {
  it('returns the same in-flight promise for concurrent callers', async () => {
    const cache = new BlockCache()
    let resolveLoader!: (value: BlockData | undefined) => void
    const loader = vi.fn(() => new Promise<BlockData | undefined>((resolve) => {
      resolveLoader = resolve
    }))

    const first = cache.dedupLoad('block-1', loader)
    const second = cache.dedupLoad('block-1', loader)

    expect(loader).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)

    resolveLoader(snap())
    await first
  })

  it('runs a fresh loader after the previous load resolves', async () => {
    const cache = new BlockCache()
    const loader = vi.fn(() => Promise.resolve(snap()))

    await cache.dedupLoad('block-1', loader)
    await cache.dedupLoad('block-1', loader)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('runs a fresh loader after the previous load rejects', async () => {
    const cache = new BlockCache()
    const failing = vi.fn(() => Promise.reject(new Error('boom')))
    await expect(cache.dedupLoad('block-1', failing)).rejects.toThrow('boom')

    const succeeding = vi.fn(() => Promise.resolve(snap()))
    await cache.dedupLoad('block-1', succeeding)
    expect(succeeding).toHaveBeenCalledTimes(1)
  })

  it('keeps loads for different ids independent', async () => {
    const cache = new BlockCache()
    const loaderA = vi.fn(() => Promise.resolve(snap({id: 'a'})))
    const loaderB = vi.fn(() => Promise.resolve(snap({id: 'b'})))

    await Promise.all([
      cache.dedupLoad('a', loaderA),
      cache.dedupLoad('b', loaderB),
    ])
    expect(loaderA).toHaveBeenCalledTimes(1)
    expect(loaderB).toHaveBeenCalledTimes(1)
  })
})

describe('BlockCache confirmed-missing markers (spec §5.2)', () => {
  it('markMissing notifies subscribers on first transition only', () => {
    const cache = new BlockCache()
    const listener = vi.fn()
    cache.subscribe('block-1', listener)

    expect(cache.markMissing('block-1')).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    expect(cache.markMissing('block-1')).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1) // not re-fired
  })

  it('isMissing reflects the marker state', () => {
    const cache = new BlockCache()
    expect(cache.isMissing('block-1')).toBe(false)
    cache.markMissing('block-1')
    expect(cache.isMissing('block-1')).toBe(true)
  })

  it('clearMissing notifies subscribers on actual clear', () => {
    const cache = new BlockCache()
    cache.markMissing('block-1')
    const listener = vi.fn()
    cache.subscribe('block-1', listener)

    expect(cache.clearMissing('block-1')).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    expect(cache.clearMissing('block-1')).toBe(false) // already clear
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('setSnapshot clears the missing marker (row exists now)', () => {
    const cache = new BlockCache()
    cache.markMissing('block-1')
    cache.setSnapshot(snap())
    expect(cache.isMissing('block-1')).toBe(false)
  })

  it('markMissing also drops any cached snapshot so Block.peek/data observe the deletion', () => {
    // Regression: a stale snapshot lingering behind the missing marker
    // would keep Block.peek / Block.data / repo.exists returning the
    // old row state because they consult the snapshot map first.
    const cache = new BlockCache()
    cache.setSnapshot(snap({content: 'lives'}))
    expect(cache.getSnapshot('block-1')?.content).toBe('lives')

    expect(cache.markMissing('block-1')).toBe(true)
    expect(cache.getSnapshot('block-1')).toBeUndefined()
    expect(cache.hasSnapshot('block-1')).toBe(false)
    expect(cache.isMissing('block-1')).toBe(true)
  })

  it('markMissing notifies once when both the marker and the snapshot transition together', () => {
    const cache = new BlockCache()
    cache.setSnapshot(snap())
    const listener = vi.fn()
    cache.subscribe('block-1', listener)

    expect(cache.markMissing('block-1')).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('markMissing notifies when only the snapshot was stale (marker already set)', () => {
    // The marker can already be set (e.g. from a prior load) while a
    // sync arrival re-populated the snapshot. The next markMissing
    // call must still wipe the snapshot AND notify so subscribers
    // observe the row going away.
    const cache = new BlockCache()
    cache.markMissing('block-1')
    cache.setSnapshot(snap()) // setSnapshot clears the marker
    cache.markMissing('block-1') // re-mark to set up the regression case
    cache.setSnapshot(snap({content: 'stale'})) // snapshot back, marker cleared again
    // Re-mark missing; the snapshot is the stale one we want gone.
    const listener = vi.fn()
    cache.subscribe('block-1', listener)
    expect(cache.markMissing('block-1')).toBe(true)
    expect(cache.getSnapshot('block-1')).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('BlockCache metrics counters', () => {
  it('starts at zero', () => {
    const cache = new BlockCache()
    expect(cache.metrics.snapshot()).toEqual({
      setSnapshotCalls: 0,
      setSnapshotDedupHits: 0,
      setSnapshotDedupMisses: 0,
      applyIfNewerSyncCalls: 0,
      applyIfNewerSyncRejected: 0,
      applyIfNewerHydrateCalls: 0,
      applyIfNewerHydrateRejected: 0,
      applyFromSyncForced: 0,
      notifies: 0,
    })
  })

  it('counts setSnapshot calls split by fingerprint dedup', () => {
    const cache = new BlockCache()
    cache.setSnapshot(snap({content: 'a'}))            // miss (first write)
    cache.setSnapshot(snap({content: 'a'}))            // hit (same fingerprint)
    cache.setSnapshot(snap({content: 'b'}))            // miss (new content)
    cache.setSnapshot(snap({content: 'b'}))            // hit
    expect(cache.metrics.setSnapshotCalls).toBe(4)
    expect(cache.metrics.setSnapshotDedupHits).toBe(2)
    expect(cache.metrics.setSnapshotDedupMisses).toBe(2)
    // Notifies fire only on misses (dedup hits skip notify).
    expect(cache.metrics.notifies).toBe(2)
  })

  it('counts applyIfNewer rejection (older updatedAt) without recursing into setSnapshot', () => {
    const cache = new BlockCache()
    cache.setSnapshot(snap({updatedAt: 100}))
    expect(cache.metrics.applyIfNewerSyncCalls).toBe(0)

    // Reject path: older updatedAt; should not increment setSnapshotCalls.
    const setBefore = cache.metrics.setSnapshotCalls
    expect(cache.applyIfNewer(snap({updatedAt: 50}), 'sync')).toBe(false)
    expect(cache.metrics.applyIfNewerSyncCalls).toBe(1)
    expect(cache.metrics.applyIfNewerSyncRejected).toBe(1)
    expect(cache.metrics.setSnapshotCalls).toBe(setBefore)

    // Accept path: newer updatedAt; setSnapshotCalls should increment too
    // (applyIfNewer delegates to setSnapshot on accept).
    expect(cache.applyIfNewer(snap({updatedAt: 200, content: 'newer'}), 'sync')).toBe(true)
    expect(cache.metrics.applyIfNewerSyncCalls).toBe(2)
    expect(cache.metrics.applyIfNewerSyncRejected).toBe(1) // unchanged
    expect(cache.metrics.setSnapshotCalls).toBe(setBefore + 1)
  })

  it('routes hydrate-source calls into their own counters', () => {
    const cache = new BlockCache()
    cache.setSnapshot(snap({updatedAt: 100}))
    expect(cache.applyIfNewer(snap({updatedAt: 50}), 'hydrate')).toBe(false)
    expect(cache.applyIfNewer(snap({updatedAt: 200, content: 'fresh'}), 'hydrate')).toBe(true)
    expect(cache.metrics.applyIfNewerHydrateCalls).toBe(2)
    expect(cache.metrics.applyIfNewerHydrateRejected).toBe(1)
    expect(cache.metrics.applyIfNewerSyncCalls).toBe(0)
    expect(cache.metrics.applyIfNewerSyncRejected).toBe(0)
  })

  it('counts notifies on deleteSnapshot / markMissing / clearMissing', () => {
    const cache = new BlockCache()
    cache.setSnapshot(snap()) // 1 notify
    cache.deleteSnapshot(snap().id) // 2 notifies
    cache.markMissing('block-1') // 3 notifies (transition)
    cache.markMissing('block-1') // no-op (already missing) — no notify
    cache.clearMissing('block-1') // 4 notifies
    cache.clearMissing('block-1') // no-op — no notify
    expect(cache.metrics.notifies).toBe(4)
  })

  it('reset() zeros every counter; snapshot returns frozen plain object', () => {
    const cache = new BlockCache()
    cache.setSnapshot(snap())
    cache.applyIfNewer(snap({content: 'x', updatedAt: 100}), 'sync')
    expect(cache.metrics.setSnapshotCalls).toBeGreaterThan(0)

    const before = cache.metrics.snapshot()
    expect(Object.isFrozen(before)).toBe(true)
    expect(() => {
      // @ts-expect-error verify snapshot is read-only at runtime
      before.notifies = 999
    }).toThrow()

    cache.metrics.reset()
    const after = cache.metrics.snapshot()
    expect(after.setSnapshotCalls).toBe(0)
    expect(after.notifies).toBe(0)
    // Prior snapshot is unaffected.
    expect(before.setSnapshotCalls).toBeGreaterThan(0)
  })
})

