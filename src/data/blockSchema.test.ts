// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  BLOCK_STORAGE_COLUMNS,
  blockToRowParams,
  ensureBlockStorageColumns,
  parseBlockRow,
  type BlockRow,
} from './blockSchema'
import type { BlockData } from '@/data/api'
import { createTestDb } from '@/data/test/createTestDb'

const fixture: BlockData = {
  id: 'b1',
  workspaceId: 'ws1',
  parentId: 'b0',
  referenceTargetId: null,
  orderKey: 'a0',
  content: 'hello',
  properties: {alias: ['Inbox']},
  references: [{id: 'ref-1', alias: 'Inbox'}],
  createdAt: 1700000000000,
  updatedAt: 1700000005000,
  createdBy: 'user-1',
  updatedBy: 'user-2',
  deleted: false,
}

const rowFromParams = (params: ReturnType<typeof blockToRowParams>): BlockRow => ({
  id: params[0],
  workspace_id: params[1],
  parent_id: params[2],
  reference_target_id: params[3],
  order_key: params[4],
  content: params[5],
  properties_json: params[6],
  references_json: params[7],
  created_at: params[8],
  updated_at: params[9],
  created_by: params[10],
  updated_by: params[11],
  deleted: params[12],
})

describe('BLOCK_STORAGE_COLUMNS', () => {
  it('declares the v2 column set; childIds-shaped columns are gone', () => {
    const names = BLOCK_STORAGE_COLUMNS.map(c => c.name)
    expect(names).toEqual([
      'id',
      'workspace_id',
      'parent_id',
      'reference_target_id',
      'order_key',
      'content',
      'properties_json',
      'references_json',
      'created_at',
      'updated_at',
      'created_by',
      'updated_by',
      'deleted',
    ])
    // Hard guard against the legacy column ever sneaking back in.
    expect(names).not.toContain('child_ids_json')
    expect(names).not.toContain('create_time')
    expect(names).not.toContain('update_time')
  })
})

describe('ensureBlockStorageColumns', () => {
  it('migrates legacy field_id value rows to reference field rows before dropping the column', async () => {
    const h = await createTestDb()
    try {
      await h.db.execute(`ALTER TABLE blocks ADD COLUMN field_id TEXT`)
      await h.db.execute(`
        CREATE INDEX idx_blocks_field_parent
        ON blocks (workspace_id, field_id, parent_id)
        WHERE deleted = 0 AND field_id IS NOT NULL
      `)
      await h.db.execute(
        `
          INSERT INTO blocks (
            id, workspace_id, parent_id, reference_target_id, field_id, order_key,
            content, properties_json, references_json, created_at, updated_at,
            created_by, updated_by, deleted
          ) VALUES
            (?, ?, NULL, NULL, NULL, ?, ?, '{}', '[]', ?, ?, ?, ?, 0),
            (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `,
        [
          'parent', 'ws', 'a0', 'Parent', 1, 1, 'user', 'user',
          'legacy-prop', 'ws', 'parent', 'property:status', 'a1', 'Doing',
          '{"note":true}', '[{"id":"target","alias":"Target"}]', 2, 2, 'user', 'user',
        ],
      )

      await ensureBlockStorageColumns(h.db)

      const fieldIdColumn = await h.db.getOptional<{name: string}>(
        `SELECT name FROM pragma_table_info('blocks') WHERE name = 'field_id'`,
      )
      expect(fieldIdColumn).toBeNull()

      await expect(h.db.getOptional<{
        content: string
        reference_target_id: string | null
        properties_json: string
        references_json: string
      }>(
        `
          SELECT content, reference_target_id, properties_json, references_json
          FROM blocks
          WHERE id = ?
        `,
        ['legacy-prop'],
      )).resolves.toEqual({
        content: '[[status]]',
        reference_target_id: 'property:status',
        properties_json: '{}',
        references_json: '[{"id":"property:status","alias":"status"}]',
      })

      await expect(h.db.getOptional<{
        parent_id: string | null
        content: string
        properties_json: string
        references_json: string
      }>(
        `
          SELECT parent_id, content, properties_json, references_json
          FROM blocks
          WHERE id = ?
        `,
        ['legacy-prop:value'],
      )).resolves.toEqual({
        parent_id: 'legacy-prop',
        content: 'Doing',
        properties_json: '{"note":true}',
        references_json: '[{"id":"target","alias":"Target"}]',
      })
    } finally {
      await h.cleanup()
    }
  })
})

describe('blockToRowParams / parseBlockRow round-trip', () => {
  it('round-trips a fully-populated block', () => {
    const params = blockToRowParams(fixture)
    const row = rowFromParams(params)
    const decoded = parseBlockRow(row)
    expect(decoded).toEqual(fixture)
  })

  it('preserves null parentId (root row)', () => {
    const root: BlockData = {...fixture, parentId: null}
    const decoded = parseBlockRow(rowFromParams(blockToRowParams(root)))
    expect(decoded.parentId).toBeNull()
  })

  it('encodes deleted=true as 1 and decodes back to boolean true', () => {
    const tombstone: BlockData = {...fixture, deleted: true}
    const params = blockToRowParams(tombstone)
    expect(params[12]).toBe(1)
    expect(parseBlockRow(rowFromParams(params)).deleted).toBe(true)
  })

  it('properties round-trip as JSON-encoded Record<string, unknown>', () => {
    const withProps: BlockData = {
      ...fixture,
      properties: {
        'tasks:done': true,
        'tasks:priority': 3,
        nested: {a: [1, 2]},
      },
    }
    const decoded = parseBlockRow(rowFromParams(blockToRowParams(withProps)))
    expect(decoded.properties).toEqual(withProps.properties)
  })

  it('references round-trip as BlockReference[]', () => {
    const refs: BlockData['references'] = [
      {id: 't1', alias: 'Inbox'},
      {id: 't2', alias: '2026-04-29'},
    ]
    const decoded = parseBlockRow(rowFromParams(blockToRowParams({...fixture, references: refs})))
    expect(decoded.references).toEqual(refs)
  })

  it('falls back to defaults on malformed JSON', () => {
    const row: BlockRow = {
      ...rowFromParams(blockToRowParams(fixture)),
      properties_json: 'not json',
      references_json: 'also not json',
    }
    const decoded = parseBlockRow(row)
    expect(decoded.properties).toEqual({})
    expect(decoded.references).toEqual([])
  })
})
