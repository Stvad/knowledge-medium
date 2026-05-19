import { CrudEntry, UpdateType } from '@powersync/common'
import type { BlockRow } from '@/data/blockSchema'
import { describe, expect, it } from 'vitest'
import {
  __compactBlockCrudEntriesForTest,
  __normalizeLocalBlockUploadRowForTest,
  __orderedBlockUpsertsForTest,
  __shouldBulkUpsertPatchesForTest,
} from './powersync'

const put = (
  clientId: number,
  id: string,
  data: Record<string, unknown>,
  txId = 1,
) => new CrudEntry(clientId, UpdateType.PUT, 'blocks', id, txId, data)

const patch = (
  clientId: number,
  id: string,
  data: Record<string, unknown>,
  txId = 1,
) => new CrudEntry(clientId, UpdateType.PATCH, 'blocks', id, txId, data)

const del = (clientId: number, id: string, txId = 1) =>
  new CrudEntry(clientId, UpdateType.DELETE, 'blocks', id, txId)

describe('PowerSync upload compaction', () => {
  it('splits PUT + PATCH chains into a create plus an accumulated patch', () => {
    // The split preserves user-intentional edits (the PATCH) while letting the
    // CREATE be a no-op when the server already has the row (deterministic-id
    // collisions during bootstrap on a fresh client — see globalState.ts).
    const operations = __compactBlockCrudEntriesForTest([
      put(1, 'block-a', {
        workspace_id: 'workspace-a',
        parent_id: null,
        order_key: 'a0',
        content: 'A',
        properties_json: '{}',
        updated_at: 1,
      }),
      patch(2, 'block-a', {
        properties_json: '{"alias":["A"]}',
        updated_at: 2,
      }),
      patch(3, 'block-a', {
        properties_json: '{"alias":["A"],"types":["page"]}',
        updated_at: 3,
      }),
    ])

    expect(operations).toEqual([
      {
        kind: 'create',
        id: 'block-a',
        order: 0,
        payload: {
          id: 'block-a',
          workspace_id: 'workspace-a',
          parent_id: null,
          order_key: 'a0',
          content: 'A',
          properties_json: '{}',
          updated_at: 1,
        },
      },
      {
        kind: 'patch',
        id: 'block-a',
        order: 0,
        payload: {
          properties_json: '{"alias":["A"],"types":["page"]}',
          updated_at: 3,
        },
      },
    ])
  })

  it('emits a pure PUT as a single create op (insert-or-skip semantics on the server)', () => {
    const operations = __compactBlockCrudEntriesForTest([
      put(1, 'block-a', {
        workspace_id: 'workspace-a',
        parent_id: null,
        order_key: 'a0',
        content: 'A',
        properties_json: '{}',
        updated_at: 1,
      }),
    ])

    expect(operations).toEqual([
      {
        kind: 'create',
        id: 'block-a',
        order: 0,
        payload: {
          id: 'block-a',
          workspace_id: 'workspace-a',
          parent_id: null,
          order_key: 'a0',
          content: 'A',
          properties_json: '{}',
          updated_at: 1,
        },
      },
    ])
  })

  it('leaves update-only edits as patch uploads for normal single-edit latency', () => {
    const operations = __compactBlockCrudEntriesForTest([
      patch(1, 'block-a', {content: 'edited', updated_at: 2}),
      patch(2, 'block-a', {references_json: '[]', updated_at: 3}),
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
        },
      },
    ])
  })

  it('lets a final delete supersede earlier writes for the same block', () => {
    const operations = __compactBlockCrudEntriesForTest([
      put(1, 'block-a', {content: 'A'}),
      patch(2, 'block-a', {content: 'B'}),
      del(3, 'block-a'),
    ])

    expect(operations).toEqual([
      {
        kind: 'delete',
        id: 'block-a',
        order: 2,
      },
    ])
  })

  it('orders parent upserts before child upserts within a bulk request', () => {
    const ordered = __orderedBlockUpsertsForTest([
      {id: 'child', parent_id: 'parent', content: 'child'},
      {id: 'parent', parent_id: null, content: 'parent'},
      {id: 'sibling', parent_id: 'parent', content: 'sibling'},
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
      deleted: 0,
    } satisfies BlockRow)

    expect(payload.deleted).toBe(false)
  })
})
