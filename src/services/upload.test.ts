import type { BlockRow } from '@/data/blockSchema'
import { describe, expect, it } from 'vitest'
import {
  UploadOperation,
  type UploadQueueEntry,
  __compactBlockUploadEntriesForTest,
  __normalizeLocalBlockUploadRowForTest,
  __orderedBlockUpsertsForTest,
  __shouldBulkUpsertPatchesForTest,
} from './upload'

const put = (
  id: string,
  data: Record<string, unknown>,
  writeId = 'write-1',
): UploadQueueEntry => ({
  table: 'blocks',
  op: UploadOperation.PUT,
  id,
  opData: data,
  writeId,
})

const patch = (
  id: string,
  data: Record<string, unknown>,
  writeId = 'write-1',
): UploadQueueEntry => ({
  table: 'blocks',
  op: UploadOperation.PATCH,
  id,
  opData: data,
  writeId,
})

const del = (id: string, writeId = 'write-1'): UploadQueueEntry => ({
  table: 'blocks',
  op: UploadOperation.DELETE,
  id,
  writeId,
})

describe('Electric upload compaction', () => {
  it('folds PUT + PATCH chains for a block into one upsert payload', () => {
    const operations = __compactBlockUploadEntriesForTest([
      put('block-a', {
        workspace_id: 'workspace-a',
        parent_id: null,
        order_key: 'a0',
        content: 'A',
        properties_json: '{}',
        updated_at: 1,
      }),
      patch('block-a', {
        properties_json: '{"alias":["A"]}',
        updated_at: 2,
      }),
      patch('block-a', {
        properties_json: '{"alias":["A"],"types":["page"]}',
        updated_at: 3,
      }),
    ])

    expect(operations).toEqual([
      {
        kind: 'upsert',
        id: 'block-a',
        order: 0,
        payload: {
          id: 'block-a',
          workspace_id: 'workspace-a',
          parent_id: null,
          order_key: 'a0',
          content: 'A',
          properties_json: '{"alias":["A"],"types":["page"]}',
          updated_at: 3,
          write_id: 'write-1',
        },
        writeId: 'write-1',
      },
    ])
  })

  it('leaves update-only edits as patch uploads for normal single-edit latency', () => {
    const operations = __compactBlockUploadEntriesForTest([
      patch('block-a', {content: 'edited', updated_at: 2}),
      patch('block-a', {references_json: '[]', updated_at: 3}),
    ])

    expect(operations).toEqual([
      {
        kind: 'patch',
        id: 'block-a',
        order: 0,
        payload: {
          content: 'edited',
          references_json: '[]',
          updated_at: 3,
          write_id: 'write-1',
        },
        writeId: 'write-1',
      },
    ])
  })

  it('lets a final delete supersede earlier writes for the same block', () => {
    const operations = __compactBlockUploadEntriesForTest([
      put('block-a', {content: 'A'}),
      patch('block-a', {content: 'B'}),
      del('block-a'),
    ])

    expect(operations).toEqual([
      {
        kind: 'delete',
        id: 'block-a',
        order: 2,
        writeId: 'write-1',
      },
    ])
  })

  it('orders parent upserts before child upserts within a bulk request', () => {
    const ordered = __orderedBlockUpsertsForTest([
      {id: 'child', parent_id: 'parent', content: 'child', write_id: 'w'},
      {id: 'parent', parent_id: null, content: 'parent', write_id: 'w'},
      {id: 'sibling', parent_id: 'parent', content: 'sibling', write_id: 'w'},
    ])

    expect(ordered.map(row => row.id)).toEqual(['parent', 'child', 'sibling'])
  })

  it('only switches patch uploads to bulk upserts for multi-row backlogs', () => {
    expect(__shouldBulkUpsertPatchesForTest([{id: 'block-a'}])).toBe(false)
    expect(__shouldBulkUpsertPatchesForTest([{id: 'block-a'}, {id: 'block-b'}])).toBe(true)
  })

  it('normalizes local SQLite block rows before remote upsert', () => {
    const payload = __normalizeLocalBlockUploadRowForTest({
      id: 'block-a',
      workspace_id: 'workspace-a',
      parent_id: null,
      order_key: 'a0',
      content: 'A',
      properties_json: '{}',
      references_json: '[]',
      created_at: 1,
      updated_at: 2,
      created_by: 'user-a',
      updated_by: 'user-a',
      write_id: null,
      deleted: 0,
    } satisfies BlockRow)

    expect(payload.deleted).toBe(false)
    expect(payload.write_id).toBe('')
  })
})
