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
 *   2. The queue is keyed by id and COALESCES, so a re-delivery (which is an
 *      `INSERT OR REPLACE` = DELETE+INSERT trigger pair) collapses to a single
 *      `'upsert'` rather than leaving a spurious `'delete'`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BLOCKS_SYNCED_RAW_TABLE, blockToRowParams } from '@/data/blockSchema'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import type { BlockData } from '@/data/api'

const data = (o: Partial<BlockData> = {}): BlockData => ({
  id: 'b1', workspaceId: 'ws1', parentId: null, orderKey: 'a0', content: 'v1',
  properties: {}, references: [], createdAt: 1, updatedAt: 1, createdBy: 'u',
  updatedBy: 'u', deleted: false, ...o,
})

let env: TestDb
beforeEach(async () => { env = await createTestDb() })
afterEach(async () => { await env.cleanup() })

const put = (d: BlockData) => env.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToRowParams(d))
const del = (id: string) => env.db.execute(BLOCKS_SYNCED_RAW_TABLE.delete.sql, [id])
const queue = () =>
  env.db.getAll<{ id: string; op: string }>('SELECT id, op FROM blocks_synced_changes ORDER BY id')
const drain = () => env.db.execute('DELETE FROM blocks_synced_changes')

describe('blocks_synced_changes capture queue', () => {
  it('records an upsert when a staging row is inserted via the raw put statement', async () => {
    await put(data({ id: 'b1' }))
    expect(await queue()).toEqual([{ id: 'b1', op: 'upsert' }])
  })

  it('records a delete when a staging row is removed via the raw delete statement', async () => {
    await put(data({ id: 'b1' }))
    await drain()
    await del('b1')
    expect(await queue()).toEqual([{ id: 'b1', op: 'delete' }])
  })

  it('coalesces a re-delivery (INSERT OR REPLACE) to a single upsert, not delete+upsert', async () => {
    await put(data({ id: 'b1', content: 'v1' }))
    await drain() // observer processed the first delivery
    // Re-deliver the SAME id with changed content. The raw put is INSERT OR
    // REPLACE, which fires a DELETE then an INSERT trigger — the keyed queue
    // must end with one 'upsert', never a stranded 'delete'.
    await put(data({ id: 'b1', content: 'v2' }))
    expect(await queue()).toEqual([{ id: 'b1', op: 'upsert' }])
  })

  it('lets a delete supersede an un-drained upsert for the same id', async () => {
    await put(data({ id: 'b1' }))
    await del('b1') // observer never got to drain the upsert
    expect(await queue()).toEqual([{ id: 'b1', op: 'delete' }])
  })

  it('keys per id — independent ids accumulate independently', async () => {
    await put(data({ id: 'a' }))
    await put(data({ id: 'b' }))
    await del('b') // 'b' re-deleted before drain
    expect(await queue()).toEqual([
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
