// @vitest-environment node
/**
 * Cutover parity (design doc §9.2, D-4 pre-flight).
 *
 * The Layout B cutover reroutes EVERY block — 100% of today's plaintext data
 * included — off the legacy `blocks` raw-table apply and onto the
 * `blocks_synced → observer → blocks` path. This pins the safety claim that
 * the two paths are observationally identical for a plaintext block: the
 * materialized `blocks` row AND every trigger-maintained derived index
 * (aliases, types, references, FTS + its rowid map) must match what the legacy
 * raw-table `put` produces. The unit tests for `materializeStagingRows` assert
 * a subset (content / properties_json / updated_at / aliases); this asserts the
 * WHOLE materialized state against the path it replaces, so the cutover is a
 * proven equivalence rather than an argument.
 *
 * Also pins the FTS-rowid-stability guarantee the observer's
 * `ON CONFLICT DO UPDATE` (rather than delete+insert) exists to provide.
 *
 * Tested against a real `@powersync/node` DB with the production schema, so the
 * trigger interactions are the real ones on both sides.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BLOCKS_RAW_TABLE,
  BLOCKS_SYNCED_RAW_TABLE,
  blockToRowParams,
} from '@/data/blockSchema'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { materializeStagingRows, type Materializability } from './materialize.js'
import type { GetCek } from '../transform.js'
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

/** Legacy path: exactly the `put` PowerSync's CRUD-apply runs into `blocks`. */
const legacyPut = (db: TestDb['db'], b: BlockData) =>
  db.execute(BLOCKS_RAW_TABLE.put.sql, blockToRowParams(b))

/** New path: stage into `blocks_synced`, then materialize via the observer core. */
const stageAndMaterialize = async (db: TestDb['db'], b: BlockData) => {
  await db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToRowParams(b))
  return materializeStagingRows(
    db,
    { upserted: [b.id], removed: [] },
    { getMaterializability: constMat('copy'), getCek: noKey },
  )
}

let ref: TestDb
let obs: TestDb
beforeEach(async () => { ref = await createTestDb(); obs = await createTestDb() })
afterEach(async () => { await ref.cleanup(); await obs.cleanup() })

describe('cutover parity — plaintext block: observer path vs legacy raw-table apply', () => {
  it('produces an identical blocks row and identical derived indexes', async () => {
    const block = richBlock()

    await legacyPut(ref.db, block)
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
    await legacyPut(ref.db, block)
    await ref.db.execute(BLOCKS_RAW_TABLE.delete.sql, [block.id])

    await stageAndMaterialize(obs.db, block)
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
