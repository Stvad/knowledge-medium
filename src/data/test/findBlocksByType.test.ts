import { describe, it, expect, vi } from 'vitest'
import type { PowerSyncDatabase } from '@powersync/web'
import { Repo } from '@/data/repo'
import { UndoRedoManager } from '@/data/undoRedo'
import { blockToRowParams } from '@/data/blockSchema'
import type { BlockData, User, BlockProperties } from '@/types'

// Stub PowerSyncDatabase that exposes a controllable getAll spy plus
// no-op implementations of the rest of the surface Repo touches.
const makeStubDb = (getAllImpl: PowerSyncDatabase['getAll']): PowerSyncDatabase =>
  ({
    onChange: () => () => {},
    writeLock: async () => undefined,
    getOptional: async () => null,
    getAll: getAllImpl,
    get: async () => ({seq: 0}),
    execute: async () => undefined,
  }) as unknown as PowerSyncDatabase

const makeUser = (): User => ({id: 'user-1', name: 'Test'})

const blockData = (overrides: Partial<BlockData> = {}): BlockData => ({
  id: overrides.id ?? 'block',
  workspaceId: overrides.workspaceId ?? 'ws-1',
  content: overrides.content ?? '',
  properties: overrides.properties ?? {},
  childIds: overrides.childIds ?? [],
  parentId: overrides.parentId,
  createTime: overrides.createTime ?? 0,
  updateTime: overrides.updateTime ?? 0,
  createdByUserId: overrides.createdByUserId ?? 'user-1',
  updatedByUserId: overrides.updatedByUserId ?? 'user-1',
  references: overrides.references ?? [],
  deleted: overrides.deleted ?? false,
})

const typeProperty = (value: string): BlockProperties => ({
  type: {name: 'type', type: 'string', value},
})

// Convert a BlockData fixture back into the row shape PowerSync's
// getAll<BlockRow>() returns. Mirrors what BlockStorage.findBlocksByType
// reads.
const toRow = (data: BlockData) => {
  const params = blockToRowParams(data)
  return {
    id: params[0],
    workspace_id: params[1],
    content: params[2],
    properties_json: params[3],
    child_ids_json: params[4],
    parent_id: params[5],
    create_time: params[6],
    update_time: params[7],
    created_by_user_id: params[8],
    updated_by_user_id: params[9],
    references_json: params[10],
    deleted: params[11],
  }
}

// Repo's constructor kicks off reactive tracking (one getAll for the
// initial event-log scan). Filter the spy down to the findBlocksByType
// SQL so we can assert against just our query.
const findCallsByType = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.filter(([sql]) =>
    typeof sql === 'string' && /json_extract\(properties_json, '\$\.type\.value'\)/.test(sql),
  )

describe('Repo.findBlocksByType', () => {
  it('passes workspaceId and type to the SQL query', async () => {
    const getAll = vi.fn(async () => [])
    const repo = new Repo(makeStubDb(getAll as PowerSyncDatabase['getAll']), new UndoRedoManager(), makeUser())

    const result = await repo.findBlocksByType('ws-1', 'extension')

    expect(result).toEqual([])
    const calls = findCallsByType(getAll)
    expect(calls).toHaveLength(1)
    const [sql, params] = calls[0]
    expect(sql).toMatch(/workspace_id\s*=\s*\?/)
    expect(params).toEqual(['ws-1', 'extension'])
  })

  // TODO(data-layer 1.6): test fixtures use legacy descriptor-shaped properties
  // ({type:{value:'extension'}}); un-skip once findBlocksByType is rewritten as a
  // queriesFacet contribution in stage 1.4 and call sites sweep in stage 1.6.
  it.skip('returns matching block data parsed from rows', async () => {
    const target = blockData({
      id: 'ext-1',
      workspaceId: 'ws-1',
      content: 'export default []',
      properties: typeProperty('extension'),
      createTime: 5,
    })
    const getAll = vi.fn(async (sql: string) => {
      // Constructor's reactive-tracking call hits a different SQL; only
      // return our row for the findBlocksByType query.
      if (/json_extract\(properties_json, '\$\.type\.value'\)/.test(sql)) {
        return [toRow(target)]
      }
      return []
    })
    const repo = new Repo(
      makeStubDb(getAll as PowerSyncDatabase['getAll']),
      new UndoRedoManager(),
      makeUser(),
    )

    const result = await repo.findBlocksByType('ws-1', 'extension')

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('ext-1')
    expect(result[0].content).toBe('export default []')
    expect(result[0].properties.type?.value).toBe('extension')
  })

  it('returns empty array when no rows match', async () => {
    const getAll = vi.fn(async () => [])
    const repo = new Repo(
      makeStubDb(getAll as PowerSyncDatabase['getAll']),
      new UndoRedoManager(),
      makeUser(),
    )

    const result = await repo.findBlocksByType('ws-1', 'extension')
    expect(result).toEqual([])
  })

  it('filters out soft-deleted blocks at the SQL level', async () => {
    // Smoke test for the `deleted = 0` predicate. Real per-row filtering
    // happens inside SQLite, which the stubbed db can't evaluate, so we
    // assert the SQL shape — Block.delete() writing the flag is covered
    // separately in blockDelete.test.ts.
    const getAll = vi.fn(async () => [])
    const repo = new Repo(makeStubDb(getAll as PowerSyncDatabase['getAll']), new UndoRedoManager(), makeUser())

    await repo.findBlocksByType('ws-1', 'extension')

    const calls = findCallsByType(getAll)
    expect(calls).toHaveLength(1)
    const [sql] = calls[0]
    expect(sql).toMatch(/deleted\s*=\s*0/)
  })

  it('hydrates the cache so repo.find(id).dataSync() reads succeed', async () => {
    const target = blockData({
      id: 'ext-2',
      workspaceId: 'ws-1',
      properties: typeProperty('extension'),
    })
    const getAll = vi.fn(async (sql: string) => {
      if (/json_extract\(properties_json, '\$\.type\.value'\)/.test(sql)) {
        return [toRow(target)]
      }
      return []
    })
    const repo = new Repo(
      makeStubDb(getAll as PowerSyncDatabase['getAll']),
      new UndoRedoManager(),
      makeUser(),
    )

    await repo.findBlocksByType('ws-1', 'extension')
    expect(repo.find('ext-2').dataSync()?.id).toBe('ext-2')
  })
})
