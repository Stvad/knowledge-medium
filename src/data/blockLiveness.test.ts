// @vitest-environment node
/**
 * Coverage for `isBlockTombstoned` / `anyBlockTombstoned` (src/data/blockLiveness.ts).
 *
 * The module exists specifically because `Block`/`repo.load` conflate "deleted"
 * and "never replicated" — both read as null, and `repo.load` markMissing's the
 * id on the way, erasing even a cached tombstone. The load-first case below is
 * the regression this module was built to fix: these functions must answer
 * from SQL directly, not from whatever the cache remembers.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { anyBlockTombstoned, isBlockTombstoned, liveBlockIds } from '@/data/blockLiveness'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
  })
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

const createBlock = async (id: string, content = id): Promise<void> => {
  await env.repo.tx(
    tx => tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content}),
    {scope: ChangeScope.BlockDefault},
  )
}

const deleteBlock = async (id: string): Promise<void> => {
  await env.repo.tx(tx => tx.delete(id), {scope: ChangeScope.BlockDefault})
}

describe('isBlockTombstoned', () => {
  it('is true for a deleted row', async () => {
    await createBlock('deleted-row')
    await deleteBlock('deleted-row')

    expect(await isBlockTombstoned(env.repo, 'deleted-row')).toBe(true)
  })

  it('is false for a live row', async () => {
    await createBlock('live-row')

    expect(await isBlockTombstoned(env.repo, 'live-row')).toBe(false)
  })

  it('is false for an id that never existed', async () => {
    expect(await isBlockTombstoned(env.repo, 'never-existed')).toBe(false)
  })

  it('still answers true after repo.load/block.load erases the cached tombstone', async () => {
    // This is the whole reason the module reads SQL directly: repo.load's
    // `deleted = 0` filter treats a tombstone identically to a missing row,
    // markMissing's the id, and clears whatever the cache remembered — so any
    // caller that inferred delete-vs-missing from the cache after a load would
    // get it wrong. isBlockTombstoned must not be fooled by this.
    await createBlock('load-first')
    await deleteBlock('load-first')
    expect(env.repo.cache.getSnapshot('load-first')?.deleted).toBe(true)

    const block = env.repo.block('load-first')
    const loaded = await block.load()
    expect(loaded).toBeNull()
    // The load did erase the cache's memory of the tombstone, as documented.
    expect(env.repo.cache.getSnapshot('load-first')).toBeUndefined()
    expect(env.repo.cache.isMissing('load-first')).toBe(true)

    expect(await isBlockTombstoned(env.repo, 'load-first')).toBe(true)
  })
})

describe('anyBlockTombstoned', () => {
  it('is false for an empty list', async () => {
    expect(await anyBlockTombstoned(env.repo, [])).toBe(false)
  })

  it('is true when any listed id is a tombstone', async () => {
    await createBlock('live-a')
    await createBlock('dead-b')
    await deleteBlock('dead-b')

    expect(await anyBlockTombstoned(env.repo, ['live-a', 'dead-b'])).toBe(true)
  })

  it('is false when all listed ids are live or missing', async () => {
    await createBlock('live-a')

    expect(await anyBlockTombstoned(env.repo, ['live-a', 'never-existed'])).toBe(false)
  })
})

describe('liveBlockIds', () => {
  it('is empty for an empty list', async () => {
    expect(await liveBlockIds(env.repo, [])).toEqual([])
  })

  it('preserves input order and treats a missing id as live (missing ≠ deleted)', async () => {
    await createBlock('live-a')
    await createBlock('dead-b')
    await deleteBlock('dead-b')

    expect(await liveBlockIds(env.repo, ['live-a', 'dead-b', 'never-existed']))
      .toEqual(['live-a', 'never-existed'])
  })

  // `pasteAsMoveImpl` calls this with `pending.blockIds` from a cut — a
  // multi-select cut of more than 500 blocks feeds a batch larger than the
  // read chunk straight through. Without chunking, a single `IN (...)`
  // query with one placeholder per id throws once the id count exceeds
  // SQLite's bound-parameter cap, and because that failure path
  // deliberately RESTORES the pending-move register (see
  // `pasteAsMoveImpl`'s doc), every later paste retries the same
  // oversized query — the cut can never complete. 600 ids (> the 500
  // chunk, mirroring `FIELD_PROBE_CHUNK` in `repo.ts`) is enough to prove
  // chunking happens; none of these ids exist in the DB at all, so (per
  // "missing ≠ deleted") every one is a survivor — this test is purely
  // about the query shape, not tombstone filtering (see the next test for
  // that, across the same chunk boundary).
  it('reads a batch larger than one chunk without any single query exceeding the chunk size', async () => {
    const ids = Array.from({length: 600}, (_, i) => `synthetic-${i}`)
    const getAllSpy = vi.spyOn(env.repo.db, 'getAll')

    const result = await liveBlockIds(env.repo, ids)

    expect(result).toEqual(ids)
    expect(getAllSpy).toHaveBeenCalledTimes(2) // ceil(600 / 500)
    for (const call of getAllSpy.mock.calls) {
      const params = call[1] as unknown[] | undefined
      expect(params?.length ?? 0).toBeLessThanOrEqual(500)
    }
  })

  it('correctly excludes tombstones on both sides of the chunk boundary', async () => {
    const ids = Array.from({length: 600}, (_, i) => `bulk-${i}`)
    await env.repo.tx(async tx => {
      for (let i = 0; i < ids.length; i++) {
        await tx.create({id: ids[i], workspaceId: WS, parentId: null, orderKey: `a${i}`, content: ids[i]})
      }
    }, {scope: ChangeScope.BlockDefault, description: 'bulk-create for chunk-boundary test'})
    // One tombstone in the first chunk (index < 500), one in the second
    // (index >= 500) — proves the per-chunk results are merged correctly,
    // not just that the first (or only) chunk is read.
    await deleteBlock('bulk-100')
    await deleteBlock('bulk-550')

    const result = await liveBlockIds(env.repo, ids)

    expect(result).toHaveLength(598)
    expect(result).not.toContain('bulk-100')
    expect(result).not.toContain('bulk-550')
    // Order preserved.
    expect(result).toEqual(ids.filter(id => id !== 'bulk-100' && id !== 'bulk-550'))
  })
})
