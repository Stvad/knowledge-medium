// @vitest-environment node
/**
 * `blocks_synced` staging table — Layout B foundation (design doc §9.2, D-1).
 *
 * Under Layout B, PowerSync stops writing downloaded blocks straight into the
 * app-visible `blocks` table and instead lands every row (plaintext AND
 * ciphertext) in a parallel `blocks_synced` staging table that a JS observer
 * later materializes. These tests pin the two load-bearing properties of that
 * staging table, both of which the observer relies on:
 *
 *   1. It mirrors the `blocks` column shape exactly, so a downloaded server
 *      row hydrates without dropping fields.
 *   2. It is a PASSIVE landing zone — it carries none of the `blocks`
 *      triggers, so a write to it neither enqueues an upload (`ps_crud`) nor
 *      logs a `row_events` audit row. (If it did, every downloaded row would
 *      echo straight back up as a local edit / a phantom history entry. The
 *      history entry for an incoming change is written when the observer
 *      materializes it into `blocks`, not at the staging write.) Its only
 *      trigger is the change-capture queue the observer drains.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BLOCKS_SYNCED_RAW_TABLE, blockToRowParams } from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import type { BlockData } from '@/data/api'

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

const fixture: BlockData = {
  id: 'b1',
  workspaceId: 'ws1',
  parentId: null,
  referenceTargetId: null,
  orderKey: 'a0',
  content: 'hello',
  properties: {},
  references: [],
  createdAt: 1700000000000,
  updatedAt: 1700000005000,
  userUpdatedAt: 1700000005000,
  createdBy: 'user-1',
  updatedBy: 'user-1',
  deleted: false,
}

let sharedDb: TestDb
let env: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
// Reuse one DB across the file; reset (not reopen) per test.
beforeEach(async () => { await resetTestDb(sharedDb.db); env = sharedDb })

describe('blocks_synced staging table', () => {
  it('mirrors the blocks column shape exactly (name + type + nullability)', async () => {
    const normalize = (rows: ColumnInfo[]) =>
      rows.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))
    const blocks = await env.db.getAll<ColumnInfo>('PRAGMA table_info(blocks)')
    const staged = await env.db.getAll<ColumnInfo>('PRAGMA table_info(blocks_synced)')
    expect(staged.length).toBeGreaterThan(0)
    expect(normalize(staged)).toEqual(normalize(blocks))
  })

  it('is a passive landing zone — a write enqueues no upload and logs no row_event', async () => {
    await env.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToRowParams(fixture))

    const crud = await env.db.getAll('SELECT id FROM ps_crud')
    expect(crud).toHaveLength(0)
    // No audit row either — row_events triggers live on `blocks`, not on the
    // staging table; the history entry is written at materialize time.
    const events = await env.db.getAll('SELECT id FROM row_events')
    expect(events).toHaveLength(0)

    // The row itself did land in staging.
    const staged = await env.db.getAll<{ id: string; content: string }>(
      'SELECT id, content FROM blocks_synced',
    )
    expect(staged).toEqual([{ id: 'b1', content: 'hello' }])
  })

  it('replaces in place on re-delivery of the same id (plain INSERT OR REPLACE, no guarded upsert)', async () => {
    await env.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToRowParams(fixture))
    await env.db.execute(
      BLOCKS_SYNCED_RAW_TABLE.put.sql,
      blockToRowParams({ ...fixture, content: 'edited', updatedAt: fixture.updatedAt + 1 }),
    )
    const rows = await env.db.getAll<{ id: string; content: string }>(
      'SELECT id, content FROM blocks_synced',
    )
    expect(rows).toEqual([{ id: 'b1', content: 'edited' }])
  })

  it('delete removes the staged row by id', async () => {
    await env.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToRowParams(fixture))
    await env.db.execute(BLOCKS_SYNCED_RAW_TABLE.delete.sql, [fixture.id])
    const rows = await env.db.getAll('SELECT id FROM blocks_synced')
    expect(rows).toHaveLength(0)
  })
})
