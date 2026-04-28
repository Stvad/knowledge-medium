import { describe, it, expect, vi } from 'vitest'
import type { PowerSyncDatabase } from '@powersync/web'
import { Repo } from '@/data/repo'
import { UndoRedoManager } from '@/data/undoRedo'
import { blockToRowParams } from '@/data/blockSchema'
import type { BlockData, User } from '@/types'

const makeStubDb = (
  overrides: Partial<{
    getAll: PowerSyncDatabase['getAll']
    getOptional: PowerSyncDatabase['getOptional']
  }> = {},
): PowerSyncDatabase =>
  ({
    onChange: () => () => {},
    writeLock: async () => undefined,
    getOptional: overrides.getOptional ?? (async () => null),
    getAll: overrides.getAll ?? (async () => []),
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

const findCalls = (
  spy: ReturnType<typeof vi.fn>,
  pattern: RegExp,
) => spy.mock.calls.filter(([sql]) => typeof sql === 'string' && pattern.test(sql))

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

describe('Repo.findBacklinks', () => {
  it('returns [] without hitting the DB on empty target id', async () => {
    const getAll = vi.fn(async () => [])
    const repo = new Repo(
      makeStubDb({getAll: getAll as PowerSyncDatabase['getAll']}),
      new UndoRedoManager(),
      makeUser(),
    )

    const result = await repo.findBacklinks('ws-1', '')
    expect(result).toEqual([])
    expect(getAll).not.toHaveBeenCalled()
  })

  it('queries with workspaceId + target id, filtered to live blocks with refs', async () => {
    const getAll = vi.fn(async () => [])
    const repo = new Repo(
      makeStubDb({getAll: getAll as PowerSyncDatabase['getAll']}),
      new UndoRedoManager(),
      makeUser(),
    )

    await repo.findBacklinks('ws-1', 'page-1')

    const calls = findCalls(getAll, /references_json\s*!=\s*'\[\]'/)
    expect(calls).toHaveLength(1)
    const [sql, params] = calls[0]
    expect(sql).toMatch(/blocks\.deleted\s*=\s*0/)
    expect(sql).toMatch(/blocks\.id\s*!=\s*\?/)
    expect(sql).toMatch(/json_each\(blocks\.references_json\)/)
    expect(params).toEqual(['ws-1', 'page-1', 'page-1'])
  })

  it('hydrates matched blocks so repo.find(id) reads succeed synchronously', async () => {
    const referencingBlock = blockData({
      id: 'block-with-link',
      workspaceId: 'ws-1',
      content: 'I link to [[Foo]]',
      references: [{id: 'page-1', alias: 'Foo', kind: 'page'}],
    })
    const getAll = vi.fn(async (sql: string) => {
      if (/references_json\s*!=\s*'\[\]'/.test(sql)) return [toRow(referencingBlock)]
      return []
    })
    const repo = new Repo(
      makeStubDb({getAll: getAll as PowerSyncDatabase['getAll']}),
      new UndoRedoManager(),
      makeUser(),
    )

    const blocks = await repo.findBacklinks('ws-1', 'page-1')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].id).toBe('block-with-link')
    expect(repo.find('block-with-link').dataSync()?.content).toBe('I link to [[Foo]]')
  })
})
