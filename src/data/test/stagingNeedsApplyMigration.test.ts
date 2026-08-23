// @vitest-environment node
/**
 * The `needs_apply` upgrade path — a device that already holds staged rows when
 * the column arrives.
 *
 * Untested, this migration fails in one direction only, and badly: the column
 * defaults to "unapplied", so a seed that does not run leaves every staged row
 * reading as a gap, and every one-way pass refuses for the life of the install.
 * Fresh installs never touch any of this (the CREATE carries the column), which
 * is exactly why nothing else in the suite exercises it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import {
  RECORD_STAGING_NEEDS_APPLY_SEEDED_SQL,
  STAGING_NEEDS_APPLY_SEEDED_MARKER_KEY,
  ensureStagingNeedsApplyColumn,
} from '@/data/internals/clientSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import type { BlockData } from '@/data/api'

const WS = 'ws-migration'

const row = (o: Partial<BlockData> = {}): BlockData => ({
  id: 'b1', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'v1',
  properties: {}, references: [], createdAt: 1, updatedAt: 5, userUpdatedAt: 5,
  createdBy: 'u', updatedBy: 'u', deleted: false, ...o,
})

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

/** Put the table back in its PRE-migration shape. `createTestDb` builds the
 *  current one, so the only way to exercise the upgrade is to drop the column
 *  again — SQLite can, and this is a scratch DB, not user data. */
const rewindToPreMigration = async () => {
  await resetTestDb(sharedDb.db)
  await sharedDb.db.execute('DROP INDEX IF EXISTS idx_blocks_synced_needs_apply')
  await sharedDb.db.execute('ALTER TABLE blocks_synced DROP COLUMN needs_apply')
  // `client_schema_state` survives a reset — it is schema state, not data,
  // which is the whole point of the marker. An earlier test's marker would
  // otherwise make every later one skip the seed and pass vacuously.
  await sharedDb.db.execute('DELETE FROM client_schema_state WHERE key = ?',
    [STAGING_NEEDS_APPLY_SEEDED_MARKER_KEY])
}

const deliver = (d: BlockData) =>
  sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams(d))

const seedLocal = (id: string, updatedAt: number, deleted = false) =>
  sharedDb.db.execute(
    `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
       created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
     VALUES (?, ?, NULL, 'a0', 'v', '{}', 1, ?, ?, 'u', 'u', ?)`,
    [id, WS, updatedAt, updatedAt, deleted ? 1 : 0])

const unapplied = async (): Promise<string[]> =>
  (await sharedDb.db.getAll<{id: string}>(
    'SELECT id FROM blocks_synced WHERE needs_apply = 1 ORDER BY id',
  )).map(r => r.id)

beforeEach(rewindToPreMigration)

describe('ensureStagingNeedsApplyColumn', () => {
  it('seeds each staged row from what the two tables can still show', async () => {
    await deliver(row({id: 'applied', updatedAt: 5}))
    await seedLocal('applied', 5)                       // I1: same nonzero stamp
    await deliver(row({id: 'behind', updatedAt: 9}))
    await seedLocal('behind', 4)                        // server ahead
    await deliver(row({id: 'never-arrived', updatedAt: 5}))   // no local row
    await deliver(row({id: 'dead-both-sides', updatedAt: 5, deleted: true}))

    await ensureStagingNeedsApplyColumn(sharedDb.db)

    expect(await unapplied()).toEqual(['behind', 'never-arrived'])
  })

  it('leaves the flag SET for a local row that is strictly newer', async () => {
    // `decideStagingRow` would APPLY the staged row over it, not skip — so the
    // seed must not read "local is ahead" as "already handled". Its echo
    // re-delivers and re-judges it; erring toward refusing costs one wait.
    await deliver(row({id: 'acked-edit', updatedAt: 4}))
    await seedLocal('acked-edit', 9)

    await ensureStagingNeedsApplyColumn(sharedDb.db)

    expect(await unapplied()).toEqual(['acked-edit'])
  })

  it('retries the seed after a crash between the ALTER and the seed', async () => {
    // The failure this is marker-gated rather than ALTER-gated for. Gated on
    // "did I add the column", the second boot skips the seed forever and every
    // workspace reads as a permanent gap.
    await deliver(row({id: 'applied', updatedAt: 5}))
    await seedLocal('applied', 5)
    await sharedDb.db.execute(
      `ALTER TABLE blocks_synced ADD COLUMN needs_apply INTEGER NOT NULL DEFAULT 1`)
    expect(await unapplied()).toEqual(['applied'])      // ALTER landed, seed did not

    await ensureStagingNeedsApplyColumn(sharedDb.db)

    expect(await unapplied()).toEqual([])
  })

  it('does not re-seed once the marker is recorded', async () => {
    // The flag is live state after the migration: a drain that legitimately
    // re-flags a row must not have it cleared again by a later boot.
    await ensureStagingNeedsApplyColumn(sharedDb.db)
    await deliver(row({id: 'arrived-later', updatedAt: 5}))
    await seedLocal('arrived-later', 5)
    expect(await unapplied()).toEqual(['arrived-later'])

    await ensureStagingNeedsApplyColumn(sharedDb.db)

    expect(await unapplied()).toEqual(['arrived-later'])
  })

  // ~215ms alone (1200 serial round-trips through the write lock) — not tight
  // against the 5000ms default, but it has timed out twice on a loaded machine,
  // and a timeout HERE strands the rest of the file: this is the test that puts
  // back the column `rewindToPreMigration` drops, so the next rewind then fails
  // on a column that is already gone. The budget is insurance against that
  // cascade, not a claim that the test is slow.
  it('seeds a backlog larger than one chunk', async () => {
    // Bounded statements, so the loop — not the WHERE — is what finishes it.
    for (let i = 0; i < 600; i++) {
      await deliver(row({id: `b${i}`, updatedAt: 5}))
      await seedLocal(`b${i}`, 5)
    }

    await ensureStagingNeedsApplyColumn(sharedDb.db)

    expect(await unapplied()).toEqual([])
  }, 30_000)

  it('is a no-op on a table that already has the column and the marker', async () => {
    await sharedDb.db.execute(
      `ALTER TABLE blocks_synced ADD COLUMN needs_apply INTEGER NOT NULL DEFAULT 1`)
    await sharedDb.db.execute(RECORD_STAGING_NEEDS_APPLY_SEEDED_SQL)
    await deliver(row({id: 'untouched', updatedAt: 5}))
    await seedLocal('untouched', 5)

    await ensureStagingNeedsApplyColumn(sharedDb.db)

    expect(await unapplied()).toEqual(['untouched'])
  })
})
