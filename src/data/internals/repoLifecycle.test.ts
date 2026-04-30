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
