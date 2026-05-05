// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from './createTestDb'
import { BLOCK_STORAGE_COLUMNS } from '@/data/blockSchema'
import {
  ALIAS_BACKFILL_MARKER_KEY,
  BLOCK_TYPES_BACKFILL_MARKER_KEY,
  CLIENT_SCHEMA_TRIGGER_NAMES,
} from '@/data/internals/clientSchema'
import { resolveLocalSchemaContributions } from '@/data/localSchema.ts'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.ts'

const localSchemaTriggerNames = resolveLocalSchemaContributions(staticDataExtensions)
  .flatMap(contribution => [...(contribution.triggerNames ?? [])])

describe('createTestDb harness', () => {
  let h: TestDb
  beforeAll(async () => {
    h = await createTestDb()
  })
  afterAll(async () => {
    await h.cleanup()
  })

  it('opens a writable PowerSyncDatabase with the v2 blocks shape', async () => {
    const cols = (await h.db.getAll<{name: string}>(
      "SELECT name FROM pragma_table_info('blocks') ORDER BY cid",
    )).map(r => r.name)
    expect(cols).toEqual(BLOCK_STORAGE_COLUMNS.map(c => c.name))
  })

  it('seeds tx_context with one NULL row across all five tx fields', async () => {
    const row = await h.db.get<Record<string, unknown>>('SELECT * FROM tx_context')
    expect(row).toEqual({id: 1, tx_id: null, tx_seq: null, user_id: null, scope: null, source: null})
  })

  it('installs the documented set of blocks triggers', async () => {
    const names = (await h.db.getAll<{name: string}>(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='blocks' ORDER BY name",
    )).map(r => r.name)
    const expected = [
      ...CLIENT_SCHEMA_TRIGGER_NAMES,
      ...localSchemaTriggerNames,
    ]
    expect(names.sort()).toEqual(expected.sort())
    expect(names).toHaveLength(expected.length)
  })

  it('installs production blocks indexes', async () => {
    const names = (await h.db.getAll<{name: string}>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='blocks'",
    )).map(r => r.name)
    expect(names).toEqual(expect.arrayContaining([
      'idx_blocks_parent_order',
      'idx_blocks_workspace_active',
    ]))
  })

  it('installs the block_types side index', async () => {
    const columns = (await h.db.getAll<{name: string}>(
      "SELECT name FROM pragma_table_info('block_types') ORDER BY cid",
    )).map(r => r.name)
    expect(columns).toEqual(['block_id', 'workspace_id', 'type'])

    const indexes = (await h.db.getAll<{name: string}>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='block_types'",
    )).map(r => r.name)
    expect(indexes).toEqual(expect.arrayContaining([
      'sqlite_autoindex_block_types_1',
      'idx_block_types_type_workspace',
    ]))
  })

  it('records side-index backfill completion markers', async () => {
    const keys = (await h.db.getAll<{key: string}>(
      'SELECT key FROM client_schema_state ORDER BY key',
    )).map(r => r.key)
    expect(keys).toEqual(expect.arrayContaining([
      ALIAS_BACKFILL_MARKER_KEY,
      BLOCK_TYPES_BACKFILL_MARKER_KEY,
    ]))
  })

  it('writeTransaction commits on success, rolls back on throw', async () => {
    await h.db.writeTransaction(async tx => {
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json, references_json, created_at, updated_at, created_by, updated_by, deleted)
         VALUES ('t-commit', 'ws', NULL, 'a0', '', '{}', '[]', 0, 0, 'u', 'u', 0)`,
      )
    })
    expect(await h.db.get<{id: string}>('SELECT id FROM blocks WHERE id = ?', ['t-commit'])).toEqual({id: 't-commit'})

    await expect(
      h.db.writeTransaction(async tx => {
        await tx.execute(
          `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json, references_json, created_at, updated_at, created_by, updated_by, deleted)
           VALUES ('t-rollback', 'ws', NULL, 'a1', '', '{}', '[]', 0, 0, 'u', 'u', 0)`,
        )
        throw new Error('intentional')
      }),
    ).rejects.toThrow('intentional')

    expect(await h.db.getOptional('SELECT id FROM blocks WHERE id = ?', ['t-rollback'])).toBeNull()
  })
})
