/**
 * Layout B observer — invalidation relocation (design doc §9.2, D-2b).
 *
 * `applySyncInvalidation` is the observer's direct replacement for the old
 * `rowEventsTail` notify path: update the cache, then emit one
 * `ChangeNotification` derived from the before/after snapshots — the same
 * helper the local `repo.tx` fast path uses.
 */

import { describe, expect, it, vi } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import type { ChangeNotification } from '@/data/internals/handleStore'
import type { InvalidationRule } from '@/data/invalidation'
import { applySyncInvalidation } from './invalidate.js'
import type { SyncSnapshot } from './materialize.js'
import type { BlockData } from '@/data/api'

const block = (overrides: Partial<BlockData> = {}): BlockData => ({
  id: 'b1',
  workspaceId: 'ws-1',
  parentId: null,
  referenceTargetId: null,
  orderKey: 'a0',
  content: 'hello',
  properties: {},
  references: [],
  createdAt: 1000,
  updatedAt: 1000,
  userUpdatedAt: 1000,
  createdBy: 'u',
  updatedBy: 'u',
  deleted: false,
  ...overrides,
})

const target = () => {
  const calls: ChangeNotification[] = []
  return { invalidate: (c: ChangeNotification) => calls.push(c), calls }
}

const snapshots = (entries: Record<string, SyncSnapshot>) =>
  new Map<string, SyncSnapshot>(Object.entries(entries))

/** ChangeNotification fields are an optional Set|array union; normalize to a
 *  plain array for assertions. */
const arr = (x?: ReadonlySet<string> | readonly string[]): string[] =>
  x ? Array.from(x) : []

describe('applySyncInvalidation', () => {
  it('writes after-snapshots to the cache and invalidates rowIds + workspaceIds', () => {
    const cache = new BlockCache()
    const handle = target()

    const after = block({ content: 'from server' })
    const out = applySyncInvalidation(cache, handle, snapshots({ b1: { before: null, after } }))

    expect(cache.getSnapshot('b1')).toMatchObject({ content: 'from server' })
    expect(handle.calls).toHaveLength(1)
    expect(out).not.toBeNull()
    expect(arr(out!.rowIds)).toEqual(['b1'])
    expect(arr(out!.workspaceIds)).toEqual(['ws-1'])
  })

  it('emits a parent-edge invalidation when a new child appears under a parent', () => {
    const cache = new BlockCache()
    const handle = target()

    const after = block({ id: 'child', parentId: 'parent-1' })
    const out = applySyncInvalidation(cache, handle, snapshots({ child: { before: null, after } }))

    expect(arr(out!.parentIds)).toEqual(['parent-1'])
  })

  it('does not invalidate a row the cache rejects as stale (LWW gate)', () => {
    const cache = new BlockCache()
    cache.applyIfNewer(block({ content: 'newer', updatedAt: 5000 }), 'sync')
    const handle = target()

    // The in-memory LWW rejects the older delivery.
    const stale = block({ content: 'older', updatedAt: 2000 })
    const out = applySyncInvalidation(cache, handle, snapshots({ b1: { before: null, after: stale } }))

    // Cache keeps the newer value; nothing dispatched.
    expect(cache.getSnapshot('b1')).toMatchObject({ content: 'newer' })
    expect(out).toBeNull()
    expect(handle.calls).toHaveLength(0)
  })

  it('heals a 0-stamped pristine default LIVE (server out-stamps the 0 sentinel)', () => {
    // The deterministic-id shadow heal in-session, post 0-sentinel. The cache
    // holds a 0-stamped pristine default; the real server value out-stamps 0, so
    // plain LWW accepts it — no force-heal needed — and wakes the row's handles.
    const cache = new BlockCache()
    const pristineDefault = block({ content: 'default', updatedAt: 0 })
    cache.applyIfNewer(pristineDefault, 'sync')
    const handle = target()

    const serverValue = block({ content: 'real synced config', updatedAt: 3000 })
    const out = applySyncInvalidation(
      cache, handle, snapshots({ b1: { before: pristineDefault, after: serverValue } }),
    )

    expect(cache.getSnapshot('b1')).toMatchObject({ content: 'real synced config' })
    expect(out).not.toBeNull()
    expect(arr(out!.rowIds)).toEqual(['b1'])
    expect(handle.calls).toHaveLength(1)
  })

  it('does NOT clobber a newer local cache value with an older server delivery (no stale-echo flash)', () => {
    // The flash regression. A real edit (nonzero stamp) is in the cache; a rescan
    // re-reads a stale pre-echo staging row and the disk gate transiently applies
    // it (no strictly-newer disk protection), passing the edit as `before`. The
    // cache LWW must REJECT the older `after` so the UI never flashes new→old→new;
    // disk self-heals on the echo. (A permanently-rejected edit likewise stays
    // until reload, when the cache rehydrates from the server-healed disk.)
    const cache = new BlockCache()
    const localEdit = block({ content: 'my edit', updatedAt: 9000 })
    cache.applyIfNewer(localEdit, 'sync')
    const handle = target()

    const staleServer = block({ content: 'stale server', updatedAt: 3000 })
    const out = applySyncInvalidation(
      cache, handle, snapshots({ b1: { before: localEdit, after: staleServer } }),
    )

    expect(cache.getSnapshot('b1')).toMatchObject({ content: 'my edit' })
    expect(out).toBeNull()
    expect(handle.calls).toHaveLength(0)
  })

  it('evicts on removal and invalidates the row + its prior parent', () => {
    const cache = new BlockCache()
    cache.applyIfNewer(block({ id: 'child', parentId: 'parent-1' }), 'sync')
    const handle = target()

    const out = applySyncInvalidation(
      cache,
      handle,
      snapshots({ child: { before: block({ id: 'child', parentId: 'parent-1' }), after: null } }),
    )

    expect(cache.getSnapshot('child')).toBeUndefined()
    expect(arr(out!.rowIds)).toEqual(['child'])
    expect(arr(out!.parentIds)).toEqual(['parent-1'])
  })

  it('runs plugin invalidation rules over the accepted snapshots', () => {
    const cache = new BlockCache()
    const handle = target()
    const rule: InvalidationRule = {
      id: 'test-rule',
      collectFromSnapshots: (snaps, emit) => {
        for (const [id] of snaps) emit('test-channel', id)
      },
    }

    const out = applySyncInvalidation(
      cache,
      handle,
      snapshots({ b1: { before: null, after: block() } }),
      [rule],
    )

    const keys = out!.plugin?.get('test-channel')
    expect(keys ? Array.from(keys) : []).toEqual(['b1'])
  })

  it('returns null and never calls invalidate when there is nothing to do', () => {
    const cache = new BlockCache()
    const handle = { invalidate: vi.fn() }
    const out = applySyncInvalidation(cache, handle, snapshots({}))
    expect(out).toBeNull()
    expect(handle.invalidate).not.toHaveBeenCalled()
  })
})
