// @vitest-environment node
/**
 * Cutover parity (design doc §9.2, D-4 pre-flight).
 *
 * The Layout B cutover routes EVERY block — 100% of plaintext data included —
 * through the `blocks_synced → observer → blocks` path. This pins the safety
 * claim that materializing a plaintext block is observationally identical to a
 * direct write into `blocks`: the materialized row AND every trigger-maintained
 * derived index (aliases, types, references, FTS + its rowid map) must match
 * what a plain INSERT produces. The unit tests for `materializeStagingRows`
 * assert a subset (content / properties_json / updated_at / aliases); this
 * asserts the WHOLE materialized state against a direct write, so the observer
 * path is a proven equivalence rather than an argument.
 *
 * Also pins the FTS-rowid-stability guarantee the observer's
 * `ON CONFLICT DO UPDATE` (rather than delete+insert) exists to provide.
 *
 * Tested against a real `@powersync/node` DB with the production schema, so the
 * trigger interactions are the real ones on both sides.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  BLOCKS_SYNCED_RAW_TABLE,
  BLOCKS_TABLE_COLUMN_NAMES,
  blockToRowParams,
  blockToSyncedRowParams,
} from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { materializeStagingRows, type Materializability } from './materialize.js'
import type { GetCek } from '@/sync/transform.js'
import type { BlockData } from '@/data/api'

const noKey: GetCek = async () => null
const constMat = (m: Materializability) => () => m

/** A block that exercises every derived index hung off `blocks`:
 *    properties.$.alias → block_aliases   properties.$.types → block_types
 *    references_json     → block_references  content → blocks_fts (+ rowid map) */
const richBlock = (overrides: Partial<BlockData> = {}): BlockData => ({
  id: 'b1',
  workspaceId: 'ws-plain',
  parentId: 'parent-1',
  orderKey: 'a0',
  content: 'searchable content',
  properties: { alias: ['Foo', 'Bar'], types: ['note', 'task'] },
  references: [{ id: 'target-1', alias: 'Target', sourceField: 'body' }],
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  userUpdatedAt: 1700000000000,
  createdBy: 'user-1',
  updatedBy: 'user-1',
  deleted: false,
  ...overrides,
})

/** Full materialized state for a block: the row plus every trigger-maintained
 *  derived index, ordered deterministically so two DBs compare cleanly. The
 *  FTS integer rowid value is an internal detail — what parity needs is that a
 *  mapping exists at all — so it's captured as a boolean, not the number. */
const derivedState = async (db: TestDb['db'], id: string) => ({
  block: (await db.getAll('SELECT * FROM blocks WHERE id = ?', [id]))[0] ?? null,
  aliases: await db.getAll(
    'SELECT block_id, workspace_id, alias, alias_lower FROM block_aliases WHERE block_id = ? ORDER BY alias',
    [id],
  ),
  types: await db.getAll(
    'SELECT block_id, workspace_id, type FROM block_types WHERE block_id = ? ORDER BY type',
    [id],
  ),
  references: await db.getAll(
    'SELECT source_id, target_id, workspace_id, alias, source_field FROM block_references WHERE source_id = ? ORDER BY target_id, alias, source_field',
    [id],
  ),
  fts: await db.getAll(
    'SELECT content, workspace_id, block_id FROM blocks_fts WHERE block_id = ?',
    [id],
  ),
  ftsRowidMapped: (await db.getAll(
    'SELECT 1 AS present FROM blocks_fts_rowids WHERE block_id = ?', [id],
  )).length === 1,
})

const INSERT_BLOCK_SQL =
  `INSERT INTO blocks (${BLOCKS_TABLE_COLUMN_NAMES.join(', ')}) ` +
  `VALUES (${BLOCKS_TABLE_COLUMN_NAMES.map(() => '?').join(', ')})`

/** Reference path: a plain direct write into `blocks` — the canonical
 *  derived-index state the observer must reproduce, independent of any
 *  particular sync-apply SQL. */
const directWrite = (db: TestDb['db'], b: BlockData) =>
  db.execute(INSERT_BLOCK_SQL, blockToRowParams(b))

/** New path: stage into `blocks_synced`, then materialize via the observer core. */
const stageAndMaterialize = async (db: TestDb['db'], b: BlockData) => {
  await db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams(b))
  return materializeStagingRows(
    db,
    { upserted: [b.id], removed: [] },
    { getMaterializability: constMat('copy'), getCek: noKey },
  )
}

// Two DBs: the "reference" (direct blocks write) and the "observer" (staged +
// materialized) path, compared for parity. Open each once; reset per test.
let sharedRef: TestDb
let sharedObs: TestDb
let ref: TestDb
let obs: TestDb
beforeAll(async () => { sharedRef = await createTestDb(); sharedObs = await createTestDb() })
afterAll(async () => { await sharedRef.cleanup(); await sharedObs.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedRef.db)
  await resetTestDb(sharedObs.db)
  ref = sharedRef
  obs = sharedObs
})

describe('cutover parity — plaintext block: observer path vs a direct blocks write', () => {
  it('produces an identical blocks row and identical derived indexes', async () => {
    const block = richBlock()

    await directWrite(ref.db, block)
    const out = await stageAndMaterialize(obs.db, block)
    expect(out.applied).toEqual([block.id])

    const refState = await derivedState(ref.db, block.id)
    const obsState = await derivedState(obs.db, block.id)

    // Sanity: the reference path actually populated every index we compare —
    // otherwise an equal-but-empty comparison would pass vacuously.
    expect(refState.aliases).toHaveLength(2)
    expect(refState.types).toHaveLength(2)
    expect(refState.references).toHaveLength(1)
    expect(refState.fts).toHaveLength(1)
    expect(refState.ftsRowidMapped).toBe(true)

    expect(obsState).toEqual(refState)
  })

  it('cleans every derived index identically on a hard delete (stream-exit)', async () => {
    const block = richBlock()

    // Seed both, then remove via each path.
    await directWrite(ref.db, block)
    await ref.db.execute('DELETE FROM blocks WHERE id = ?', [block.id])

    await stageAndMaterialize(obs.db, block)
    // A real stream-exit deletes the staging row — that DELETE is what enqueues
    // the 'delete' op. The observer only hard-deletes the local row once the
    // staging row is gone (a 'delete' with the staging row still present is an
    // INSERT OR REPLACE re-delivery artifact, not a removal).
    await obs.db.execute(BLOCKS_SYNCED_RAW_TABLE.delete.sql, [block.id])
    const out = await materializeStagingRows(
      obs.db,
      { upserted: [], removed: [block.id] },
      { getMaterializability: constMat('copy'), getCek: noKey },
    )
    expect(out.deleted).toEqual([block.id])

    const refState = await derivedState(ref.db, block.id)
    const obsState = await derivedState(obs.db, block.id)
    // Both fully cleaned — row gone, every derived index empty, rowid unmapped.
    expect(refState.block).toBeNull()
    expect(refState.ftsRowidMapped).toBe(false)
    expect(obsState).toEqual(refState)
  })
})

describe('cutover parity — FTS rowid stability across re-materialization', () => {
  it('keeps the same blocks_fts rowid when the observer re-applies an edited row', async () => {
    await stageAndMaterialize(obs.db, richBlock({ content: 'first revision' }))
    const rowidBefore = (await obs.db.getAll<{ fts_rowid: number }>(
      'SELECT fts_rowid FROM blocks_fts_rowids WHERE block_id = ?', ['b1'],
    ))[0]!.fts_rowid

    // A strictly-newer server revision re-materializes through
    // ON CONFLICT DO UPDATE — the UPDATE shape (not delete+insert) is what
    // preserves the FTS rowid across the edit.
    const out = await stageAndMaterialize(
      obs.db, richBlock({ content: 'second revision', updatedAt: 1700000001000 }),
    )
    expect(out.applied).toEqual(['b1'])

    const rowidAfter = (await obs.db.getAll<{ fts_rowid: number }>(
      'SELECT fts_rowid FROM blocks_fts_rowids WHERE block_id = ?', ['b1'],
    ))[0]!.fts_rowid
    expect(rowidAfter).toBe(rowidBefore)

    // …and the index reflects the new content, with exactly one FTS row.
    expect(await obs.db.getAll<{ content: string }>(
      'SELECT content FROM blocks_fts WHERE block_id = ?', ['b1'],
    )).toEqual([{ content: 'second revision' }])
  })
})
