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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { anyBlockTombstoned, isBlockTombstoned } from '@/data/blockLiveness'

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
