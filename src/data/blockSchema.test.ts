import { describe, expect, it } from 'vitest'
import {
  BLOCK_STORAGE_COLUMNS,
  blockToRowParams,
  parseBlockRow,
  type BlockRow,
} from './blockSchema'
import type { BlockData } from '@/data/api'

const fixture: BlockData = {
  id: 'b1',
  workspaceId: 'ws1',
  parentId: 'b0',
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
  order_key: params[3],
  content: params[4],
  properties_json: params[5],
  references_json: params[6],
  created_at: params[7],
  updated_at: params[8],
  created_by: params[9],
  updated_by: params[10],
  deleted: params[11],
})

describe('BLOCK_STORAGE_COLUMNS', () => {
  it('declares the v2 column set; childIds-shaped columns are gone', () => {
    const names = BLOCK_STORAGE_COLUMNS.map(c => c.name)
    expect(names).toEqual([
      'id',
      'workspace_id',
      'parent_id',
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
    expect(params[11]).toBe(1)
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
