// @vitest-environment node
/**
 * `isBlockCommitted` — the reconciler's reap-vs-promote pivot — against a real
 * Layout-B DB. The regression it guards: a committed-and-synced block that the
 * throttled observer hasn't materialized into `blocks` yet (or can't — locked
 * e2ee / quarantined / skip-stale) still lives in `blocks_synced`, so treating
 * `repo.load` (which reads only `blocks`) as the sole presence signal would reap
 * a real block's only un-uploaded bytes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import { BLOCKS_SYNCED_RAW_TABLE, blockToRowParams } from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { isBlockCommitted } from './assetUpload.js'

describe('isBlockCommitted (reconciler presence pivot)', () => {
  let sharedDb: TestDb
  let repo: Repo

  beforeAll(async () => {
    sharedDb = await createTestDb()
  })
  afterAll(async () => {
    await sharedDb.cleanup()
  })
  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    // No observer — a staged `blocks_synced` row stays UNmaterialized, modelling
    // the post-`hasSynced` / pre-materialize (or locked / quarantined) window.
    repo = new Repo({ db: sharedDb.db, cache: new BlockCache(), user: { id: 'u1' }, startSyncObserver: false })
  })

  /** Stage a downloaded row into `blocks_synced` without materializing it. */
  const stageSynced = (id: string, workspaceId = 'ws-1'): Promise<unknown> =>
    sharedDb.db.execute(
      BLOCKS_SYNCED_RAW_TABLE.put.sql,
      blockToRowParams({
        id,
        workspaceId,
        parentId: null,
        orderKey: 'a0',
        content: '',
        properties: {},
        references: [],
        createdAt: 0,
        updatedAt: 0,
        userUpdatedAt: 0,
        createdBy: 'remote',
        updatedBy: 'remote',
        deleted: false,
      }),
    )

  it('is false for a block in neither blocks nor blocks_synced (a genuine orphan — reapable)', async () => {
    expect(await isBlockCommitted(repo, 'media:ws-1:ghost')).toBe(false)
  })

  it('is true for a committed-and-synced block still UNMATERIALIZED in blocks_synced', async () => {
    await stageSynced('media:ws-1:synced')
    // The headline gap: repo.load (only `blocks`) sees nothing, yet the block exists.
    expect(await repo.load('media:ws-1:synced')).toBeNull()
    expect(await isBlockCommitted(repo, 'media:ws-1:synced')).toBe(true)
  })
})
