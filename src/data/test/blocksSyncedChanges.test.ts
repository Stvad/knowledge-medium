// @vitest-environment node
/**
 * `blocks_synced_changes` change-capture queue (Layout B D-2c).
 *
 * The observer can't afford an O(N) re-scan of the whole staging table on every
 * startup/tick (design doc §9.2 + scaling discussion), so detection is a tiny
 * coalescing work-queue: triggers on `blocks_synced` record one row per changed
 * id (`'upsert'` / `'delete'`); the observer drains only the pending set.
 *
 * These tests pin the two load-bearing properties:
 *   1. The triggers fire on the EXACT put/delete statements PowerSync's
 *      sync-apply runs against the raw table (`BLOCKS_SYNCED_RAW_TABLE`) — the
 *      same mechanism the existing `row_events` triggers rely on for the live
 *      `blocks` table.
 *   2. It's a seq-keyed log drained race- and failure-safely with a watermark.
 *      It's append-only except for one targeted collapse: the insert trigger
 *      drops a pending same-id 'delete' before appending its 'upsert', so a
 *      re-delivery (`INSERT OR REPLACE` = DELETE+INSERT — how PowerSync applies
 *      every *changed* synced row) nets a single 'upsert' instead of a redundant
 *      delete+upsert pair (the ~2× pending-count inflation fix). The effective
 *      state of an id is still its highest-seq op; drain-time coalescing (latest
 *      op per id) handles the rest.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import type { BlockData } from '@/data/api'

const data = (o: Partial<BlockData> = {}): BlockData => ({
  id: 'b1', workspaceId: 'ws1', parentId: null, orderKey: 'a0', content: 'v1',
  properties: {}, references: [], createdAt: 1, updatedAt: 1, userUpdatedAt: 1, createdBy: 'u',
  updatedBy: 'u', deleted: false, ...o,
})

let sharedDb: TestDb
let env: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
// Reuse one DB across the file; reset (not reopen) per test.
beforeEach(async () => { await resetTestDb(sharedDb.db); env = sharedDb })

const put = (d: BlockData) => env.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams(d))
const del = (id: string) => env.db.execute(BLOCKS_SYNCED_RAW_TABLE.delete.sql, [id])
/** Effective state the observer drains: highest-seq op per id. */
const latestOps = () =>
  env.db.getAll<{ id: string; op: string }>(
    `SELECT id, op FROM blocks_synced_changes
      WHERE seq IN (SELECT MAX(seq) FROM blocks_synced_changes GROUP BY id)
      ORDER BY id`,
  )
const rowCount = async () =>
  (await env.db.getAll('SELECT seq FROM blocks_synced_changes')).length
const drain = () => env.db.execute('DELETE FROM blocks_synced_changes')

describe('blocks_synced_changes capture queue', () => {
  it('records an upsert when a staging row is inserted via the raw put statement', async () => {
    await put(data({ id: 'b1' }))
    expect(await latestOps()).toEqual([{ id: 'b1', op: 'upsert' }])
    expect(await rowCount()).toBe(1)
  })

  it('records a delete when a staging row is removed via the raw delete statement', async () => {
    await put(data({ id: 'b1' }))
    await drain()
    await del('b1')
    expect(await latestOps()).toEqual([{ id: 'b1', op: 'delete' }])
  })

  it('collapses a REPLACE re-delivery to a single upsert (drops the pending delete at enqueue)', async () => {
    await put(data({ id: 'b1', content: 'v1' }))
    await drain() // observer processed the first delivery
    // Re-deliver the SAME id (existing staging row). The raw put is INSERT OR
    // REPLACE, which fires DELETE then INSERT. The insert trigger drops the
    // pending same-id 'delete' before appending its 'upsert', so the REPLACE
    // nets a SINGLE 'upsert' row — not a delete+upsert pair. PowerSync applies
    // every changed synced row as a REPLACE, so without the collapse each one
    // would enqueue two rows (the ~2× pending-count inflation this fix removes).
    await put(data({ id: 'b1', content: 'v2' }))
    expect(await rowCount()).toBe(1)
    expect(await latestOps()).toEqual([{ id: 'b1', op: 'upsert' }])
  })

  it('collapses an un-drained delete-then-reinsert to a single upsert (final state present)', async () => {
    await put(data({ id: 'b1' })) // upsert
    await del('b1') // delete enqueued; observer never drained it
    // The row comes back (a separate re-insert, not a REPLACE — the staging row
    // is gone). The insert trigger still drops the pending 'delete' before
    // appending its 'upsert', so the queue converges to 'upsert' (final staging
    // state is present), which is what the materialize would converge to anyway.
    await put(data({ id: 'b1' }))
    expect(await latestOps()).toEqual([{ id: 'b1', op: 'upsert' }])
  })

  it('lets a genuine later delete (no following insert) supersede an un-drained upsert', async () => {
    await put(data({ id: 'b1' }))
    await del('b1') // observer never got to drain the upsert; no re-insert follows
    expect(await latestOps()).toEqual([{ id: 'b1', op: 'delete' }])
  })

  it('keys per id — independent ids accumulate independently', async () => {
    await put(data({ id: 'a' }))
    await put(data({ id: 'b' }))
    await del('b') // 'b' re-deleted before drain
    expect(await latestOps()).toEqual([
      { id: 'a', op: 'upsert' },
      { id: 'b', op: 'delete' },
    ])
  })

  it('a write to blocks_synced does NOT enqueue an upload (ps_crud stays empty)', async () => {
    await put(data({ id: 'b1' }))
    const crud = await env.db.getAll('SELECT id FROM ps_crud')
    expect(crud).toHaveLength(0)
  })
})
