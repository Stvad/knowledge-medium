// @vitest-environment node
/**
 * `Repo.syncViewGap()` — why this device's view of the graph is incomplete.
 *
 * The staged-rows clause asks a question the DRAIN also asks, so the two must
 * agree: a staging row the drain would discard as a no-op leaves the view
 * complete, and reporting it as a gap refuses work for no reason. The one that
 * matters in practice is a device's OWN upload echo — every local write comes
 * back down the sync stream and re-stages, carrying the stamp it was written
 * with (measured on a live client: identical `updated_at`).
 *
 * The agreement is `decideStagingRow`'s invariant I1 (`reconcile.ts`): equal
 * nonzero stamps ⟺ identical content, because the server strictly advances the
 * stamp on any content change. Those rows resolve `skip-stale` and change
 * nothing. I2's `0` sentinel is the documented exception — a 0-stamped local
 * row always yields — so it stays a gap.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { ChangeScope } from '@/data/api'
import type { BlockData } from '@/data/api'

const WS = 'ws1'

const syncedRow = (o: Partial<BlockData> = {}): BlockData => ({
  id: 'b1', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'v1',
  properties: {}, references: [], createdAt: 1, updatedAt: 1, userUpdatedAt: 1, createdBy: 'u',
  updatedBy: 'u', deleted: false, ...o,
})

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })

const makeRepo = () => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  return repo
}

/** Write the staging row through the EXACT statement PowerSync's sync-apply
 *  uses, so the capture trigger stages it the way a real arrival does. */
const deliver = (d: BlockData) =>
  sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams(d))

const localStamp = async (id: string): Promise<number> =>
  (await sharedDb.db.getOptional<{updated_at: number}>(
    'SELECT updated_at FROM blocks WHERE id = ?', [id],
  ))!.updated_at

describe('Repo.syncViewGap', () => {
  it('reports no gap when the only staged rows are this device\'s own echo', async () => {
    // THE case that decides whether a long uploading pass can finish: it
    // commits, its rows echo back, and they are staged for most of the run.
    const repo = makeRepo()
    await repo.tx(async tx => {
      await tx.create({workspaceId: WS, parentId: null, orderKey: 'a0', content: 'mine'})
    }, {scope: ChangeScope.BlockDefault})
    const [{id}] = await sharedDb.db.getAll<{id: string}>('SELECT id FROM blocks LIMIT 1')

    await deliver(syncedRow({id, content: 'mine', updatedAt: await localStamp(id)}))

    expect(await sharedDb.db.getAll('SELECT seq FROM blocks_synced_changes')).toHaveLength(1)
    expect(await repo.syncViewGap()).toBeNull()
  })

  it('reports a gap when a staged row carries a newer stamp than the local one', async () => {
    const repo = makeRepo()
    await repo.tx(async tx => {
      await tx.create({workspaceId: WS, parentId: null, orderKey: 'a0', content: 'mine'})
    }, {scope: ChangeScope.BlockDefault})
    const [{id}] = await sharedDb.db.getAll<{id: string}>('SELECT id FROM blocks LIMIT 1')

    await deliver(syncedRow({id, content: 'theirs', updatedAt: await localStamp(id) + 1}))

    expect(await repo.syncViewGap()).toMatch(/draining/)
  })

  it('reports a gap for a staged row this device has no local row for at all', async () => {
    const repo = makeRepo()
    await deliver(syncedRow({id: 'arrived', updatedAt: 5}))
    expect(await repo.syncViewGap()).toMatch(/draining/)
  })

  it('reports a gap when the local row is 0-stamped, which always yields (I2)', async () => {
    // A speculative deterministic-id mint. Equal stamps do NOT mean identical
    // content here, so the drain applies and the view really is incomplete.
    const repo = makeRepo()
    await sharedDb.db.writeTransaction(async tx => {
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
           created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
         VALUES ('minted', ?, NULL, 'a0', 'v', '{}', 0, 0, 0, 'u', 'u', 0)`, [WS])
    })
    await deliver(syncedRow({id: 'minted', updatedAt: 0}))
    expect(await repo.syncViewGap()).toMatch(/draining/)
  })

  it('reports a gap for a staged delete even though no synced row remains', async () => {
    const repo = makeRepo()
    await deliver(syncedRow({id: 'gone', updatedAt: 5}))
    await sharedDb.db.execute('DELETE FROM blocks_synced_changes')
    await sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.delete.sql, ['gone'])

    expect(await repo.syncViewGap()).toMatch(/draining/)
  })
})
