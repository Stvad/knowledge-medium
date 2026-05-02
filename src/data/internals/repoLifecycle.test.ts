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
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/internals/repo'

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
  it('exposes handleStore and blockCache subsections; both start at zero', () => {
    const m = env.repo.metrics()
    expect(Object.keys(m).sort()).toEqual(['blockCache', 'handleStore'])
    expect(Object.isFrozen(m)).toBe(true)
    expect(m.handleStore.invalidations).toBe(0)
    expect(m.blockCache.setSnapshotCalls).toBe(0)
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
})
