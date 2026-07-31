import { describe, expect, it } from 'vitest'
import {
  BLOCK_LOCAL_COLUMNS,
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
  // Set explicitly (rather than left undefined) so `toEqual` against
  // `parseBlockRow`'s output below matches: parseBlockRow always normalizes
  // this LOCAL-only column to `null` (PR #288 slice A), never `undefined`.
  referenceTargetId: null,
  // Same normalize-always contract for the field-form bit (false, never
  // undefined).
  isFieldForm: false,
  orderKey: 'a0',
  content: 'hello',
  properties: {alias: ['Inbox']},
  references: [{id: 'ref-1', alias: 'Inbox'}],
  createdAt: 1700000000000,
  updatedAt: 1700000005000,
  userUpdatedAt: 1700000005000,
  createdBy: 'user-1',
  updatedBy: 'user-2',
  deleted: false,
}

// Build the row exactly as production binds it: column
// [...BLOCK_STORAGE_COLUMNS, ...BLOCK_LOCAL_COLUMNS][i] receives
// blockToRowParams()[i]. txEngine's INSERT into `blocks` binds storage +
// local columns in that order (matching `BLOCKS_TABLE_COLUMN_NAMES`); the
// blocks_synced raw-table `put` binds storage columns only (`blockToSyncedRowParams`,
// covered separately). Zipping the two here (rather than hard-coding tuple
// indexes) makes every round-trip below a guard on that order ↔ params
// invariant — a reorder/added column lands values under the wrong column
// name and fails the decode.
const ROW_COLUMNS = [...BLOCK_STORAGE_COLUMNS, ...BLOCK_LOCAL_COLUMNS]
const rowFromParams = (params: ReturnType<typeof blockToRowParams>): BlockRow => {
  const row: Record<string, unknown> = {}
  ROW_COLUMNS.forEach((column, index) => {
    row[column.name] = params[index]
  })
  return row as unknown as BlockRow
}

describe('BLOCK_STORAGE_COLUMNS', () => {
  // The column set + ORDER is guarded against blockToRowParams by the
  // ROW_COLUMNS-zipped round-trip below (a reorder mis-binds and fails the
  // decode); the count guard here catches an added/removed column that the
  // round-trip's named decode would otherwise skip. A literal copy of the
  // name list would only restate the source, so it's gone — but the legacy
  // *name* guards stay (the round-trip can't catch a renamed-back column).
  it('binds exactly one positional param per blocks-table column (storage + local)', () => {
    expect(blockToRowParams(fixture)).toHaveLength(ROW_COLUMNS.length)
  })

  it('never reintroduces legacy / renamed columns', () => {
    const names = BLOCK_STORAGE_COLUMNS.map(c => c.name)
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

  it('userUpdatedAt falls back to updated_at when the column is NULL (old-rules / pre-split row)', () => {
    const row: BlockRow = {
      ...rowFromParams(blockToRowParams(fixture)),
      user_updated_at: null,
    }
    expect(parseBlockRow(row).userUpdatedAt).toBe(fixture.updatedAt)
  })
})
