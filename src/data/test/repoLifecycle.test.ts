// @vitest-environment node
/**
 * Repo lifecycle tests — small but durable contracts on the Repo
 * surface that aren't pinned by the engine / mutator / query test
 * suites:
 *
 *   - block(id) identity stability (memoized facade per id)
 *   - block(id) — different ids yield different facades
 *   - block(id) — different Repo instances yield different facades
 *     even for the same id
 *   - setReadOnly toggles isReadOnly visibly to subsequent reads
 *   - activeWorkspaceId getter/setter round-trip; null is allowed
 *   - instanceId is unique across Repo constructions (memoize-key
 *     contract used by globalState.ts)
 *
 * Spec §5.2 / §3 / §8. These behaviors persist through Phase 2-3
 * (the spec keeps `block(id)` as a sync facade getter, replacing
 * its return type with a Handle later but keeping the identity
 * contract).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import { ChangeScope } from '@/data/api'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '../repo'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
  })
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

describe('repo.block(id) identity stability', () => {
  it('returns the same Block instance on repeated calls for the same id', () => {
    const a = env.repo.block('id-1')
    const b = env.repo.block('id-1')
    expect(a).toBe(b)
  })

  it('returns a different Block instance for different ids', () => {
    const a = env.repo.block('id-1')
    const b = env.repo.block('id-2')
    expect(a).not.toBe(b)
    expect(a.id).toBe('id-1')
    expect(b.id).toBe('id-2')
  })

  it('returns a different Block across Repo instances even for the same id', async () => {
    const otherEnv = await setup()
    try {
      const a = env.repo.block('shared')
      const b = otherEnv.repo.block('shared')
      expect(a).not.toBe(b)
      // Each Block is bound to its constructing Repo.
      expect(a.repo).toBe(env.repo)
      expect(b.repo).toBe(otherEnv.repo)
    } finally {
      await otherEnv.h.cleanup()
    }
  })
})

describe('repo.setReadOnly', () => {
  it('starts non-read-only by default and flips both ways', () => {
    expect(env.repo.isReadOnly).toBe(false)
    env.repo.setReadOnly(true)
    expect(env.repo.isReadOnly).toBe(true)
    env.repo.setReadOnly(false)
    expect(env.repo.isReadOnly).toBe(false)
  })

  it('respects opts.isReadOnly at construction', async () => {
    const h = await createTestDb()
    try {
      const repo = new Repo({
        db: h.db,
        cache: new BlockCache(),
        user: {id: 'u'},
        isReadOnly: true,
      })
      expect(repo.isReadOnly).toBe(true)
    } finally {
      await h.cleanup()
    }
  })
})

describe('repo.activeWorkspaceId', () => {
  it('starts null and round-trips through the setter', () => {
    expect(env.repo.activeWorkspaceId).toBeNull()
    env.repo.setActiveWorkspaceId('ws-1')
    expect(env.repo.activeWorkspaceId).toBe('ws-1')
    env.repo.setActiveWorkspaceId('ws-2')
    expect(env.repo.activeWorkspaceId).toBe('ws-2')
    env.repo.setActiveWorkspaceId(null)
    expect(env.repo.activeWorkspaceId).toBeNull()
  })
})

describe('repo.instanceId', () => {
  it('is unique per Repo construction (memoize-key contract)', async () => {
    const a = await setup()
    const b = await setup()
    try {
      expect(a.repo.instanceId).not.toBe(b.repo.instanceId)
      expect(a.repo.instanceId).not.toBe(env.repo.instanceId)
      expect(b.repo.instanceId).not.toBe(env.repo.instanceId)
    } finally {
      await a.h.cleanup()
      await b.h.cleanup()
    }
  })

  it('is a number', () => {
    expect(typeof env.repo.instanceId).toBe('number')
  })
})

describe('repo.metrics() / resetMetrics()', () => {
  it('exposes all four subsections; all start empty / at zero', () => {
    const m = env.repo.metrics()
    expect(Object.keys(m).sort()).toEqual(['blockCache', 'db', 'handleStore', 'queries'])
    expect(Object.isFrozen(m)).toBe(true)
    expect(m.handleStore.invalidations).toBe(0)
    expect(m.blockCache.setSnapshotCalls).toBe(0)
    // queries: empty map (no query has run yet).
    expect(Object.keys(m.queries)).toEqual([])
    // db: every method bucket is initialised with zero samples.
    expect(m.db.getAll.calls).toBe(0)
    expect(m.db.writeTransaction.calls).toBe(0)
  })

  it('snapshots are independent across reset (prior snapshot keeps its values)', () => {
    env.repo.cache.setSnapshot({
      id: 'block-1', workspaceId: 'ws', parentId: null, orderKey: 'a',
      content: '', properties: {}, references: [],
      createdAt: 0, updatedAt: 0, createdBy: 'u', updatedBy: 'u', deleted: false,
    })
    const before = env.repo.metrics()
    expect(before.blockCache.setSnapshotCalls).toBe(1)

    env.repo.resetMetrics()
    const after = env.repo.metrics()
    expect(after.blockCache.setSnapshotCalls).toBe(0)
    // The earlier snapshot retains its values — frozen and detached.
    expect(before.blockCache.setSnapshotCalls).toBe(1)
  })

  it('reflects HandleStore activity end-to-end', async () => {
    // Drive a real LoaderHandle through the store via repo.query.
    // (We don't need any data; the dispatcher creates the handle and
    // running .load() triggers loaderRuns.)
    const handle = env.repo.query.children({id: 'nonexistent-id'})
    await handle.load() // empty children list — succeeds with []

    const m = env.repo.metrics()
    expect(m.handleStore.loaderRuns).toBe(1)

    // Direct invalidate that matches the parent-edge dep declared by
    // the children loader. Walks 1 handle, matches 1.
    env.repo.handleStore.invalidate({parentIds: ['nonexistent-id']})
    const after = env.repo.metrics()
    expect(after.handleStore.invalidations).toBe(1)
    expect(after.handleStore.handlesWalked).toBe(1)
    expect(after.handleStore.handlesMatched).toBe(1)
  })

  it('records per-query resolve timings keyed by full query name', async () => {
    env.repo.resetMetrics()
    await env.repo.query.children({id: 'x1'}).load()
    await env.repo.query.children({id: 'x2'}).load()
    await env.repo.query.subtree({id: 'x1'}).load()

    const m = env.repo.metrics()
    expect(m.queries['core.children'].calls).toBe(2)
    expect(m.queries['core.subtree'].calls).toBe(1)
    // Each entry is a plain TimingSnapshot with non-negative timings.
    expect(m.queries['core.children'].meanMs).toBeGreaterThanOrEqual(0)
    expect(m.queries['core.children'].sampleCount).toBe(2)
  })

  it('records db method timings end-to-end (read calls + writeTransaction wall + inner SQL)', async () => {
    // Drive a write through repo.tx directly — keeps the test free of
    // mutator-graph preconditions (createChild requires the parent to
    // exist, etc.) while still exercising the wrapped writeTransaction
    // path. The empty-tx case still opens / closes a transaction.
    env.repo.resetMetrics()
    await env.repo.tx(async () => {
      // No-op tx; we just want writeTransaction wall-clock to land
      // somewhere observable.
    }, {scope: ChangeScope.BlockDefault})

    const afterWrite = env.repo.metrics()
    expect(afterWrite.db.writeTransaction.calls).toBeGreaterThanOrEqual(1)
    // Inner execute counts: the tx pipeline writes at least the
    // tx_context row + command_events row, both via execute().
    expect(afterWrite.db.execute.calls).toBeGreaterThanOrEqual(1)

    // A read-only path: repo.load(id) on an unknown id still hits
    // SQL once via getOptional. Confirms reads outside writeTransaction
    // also flow through the timed proxy.
    env.repo.resetMetrics()
    await env.repo.load('definitely-not-a-real-id')
    const afterRead = env.repo.metrics()
    expect(afterRead.db.getAll.calls + afterRead.db.getOptional.calls + afterRead.db.get.calls)
      .toBeGreaterThanOrEqual(1)
    expect(afterRead.db.writeTransaction.calls).toBe(0)
  })

  it('resetMetrics() clears query and db reservoirs too', async () => {
    await env.repo.query.children({id: 'reset-test'}).load()
    expect(env.repo.metrics().queries['core.children'].calls).toBeGreaterThan(0)
    env.repo.resetMetrics()
    const after = env.repo.metrics()
    expect(Object.keys(after.queries)).toEqual([])
    expect(after.db.getAll.calls).toBe(0)
    expect(after.db.writeTransaction.calls).toBe(0)
  })
})
