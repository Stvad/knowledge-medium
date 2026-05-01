// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from './createTestDb'
import { BLOCK_STORAGE_COLUMNS } from '@/data/blockSchema'
import { CLIENT_SCHEMA_TRIGGER_NAMES } from '@/data/internals/clientSchema'

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
    expect(names.sort()).toEqual([...CLIENT_SCHEMA_TRIGGER_NAMES].sort())
    expect(names).toHaveLength(CLIENT_SCHEMA_TRIGGER_NAMES.length)
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
