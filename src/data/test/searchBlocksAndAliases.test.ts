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
})

const aliasProperties = (...aliases: string[]) => ({
  alias: {name: 'alias', type: 'list' as const, value: aliases},
})

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
  }
}

const findCalls = (
  spy: ReturnType<typeof vi.fn>,
  pattern: RegExp,
) => spy.mock.calls.filter(([sql]) => typeof sql === 'string' && pattern.test(sql))

describe('Repo.getAliasesInWorkspace', () => {
  it('passes workspaceId and filter to the workspace-scoped query', async () => {
    const getAll = vi.fn(async () => [])
    const repo = new Repo(
      makeStubDb({getAll: getAll as PowerSyncDatabase['getAll']}),
      new UndoRedoManager(),
      makeUser(),
    )

    await repo.getAliasesInWorkspace('ws-1', 'foo')

    const calls = findCalls(getAll, /\$\.alias\.value.*workspace_id\s*=\s*\?/s)
    expect(calls).toHaveLength(1)
    const [, params] = calls[0]
    expect(params).toEqual(['ws-1', 'foo', 'foo'])
  })

  it('returns alias strings in row order', async () => {
    const getAll = vi.fn(async (sql: string) => {
      if (/\$\.alias\.value/.test(sql) && /GROUP BY alias\.value/.test(sql)) {
        return [{alias: 'foo'}, {alias: 'foobar'}]
      }
      return []
    })
    const repo = new Repo(
      makeStubDb({getAll: getAll as PowerSyncDatabase['getAll']}),
      new UndoRedoManager(),
      makeUser(),
    )

    const result = await repo.getAliasesInWorkspace('ws-1', 'foo')
    expect(result).toEqual(['foo', 'foobar'])
  })
})

describe('Repo.findBlockByAliasInWorkspace', () => {
  it('returns null without querying when alias is empty', async () => {
    const getOptional = vi.fn(async () => null)
    const repo = new Repo(
      makeStubDb({getOptional: getOptional as PowerSyncDatabase['getOptional']}),
      new UndoRedoManager(),
      makeUser(),
    )

    const result = await repo.findBlockByAliasInWorkspace('ws-1', '')
    expect(result).toBeNull()
    expect(getOptional).not.toHaveBeenCalled()
  })

  it('returns the matching block and hydrates the cache', async () => {
    const target = blockData({
      id: 'page-1',
      workspaceId: 'ws-1',
      content: 'page content',
      properties: aliasProperties('Foo'),
    })
    const getOptional = vi.fn(async (sql: string) => {
      if (/\$\.alias\.value.*alias\.value\s*=\s*\?/s.test(sql)) {
        return toRow(target)
      }
      return null
    })
    const repo = new Repo(
      makeStubDb({getOptional: getOptional as PowerSyncDatabase['getOptional']}),
      new UndoRedoManager(),
      makeUser(),
    )

    const block = await repo.findBlockByAliasInWorkspace('ws-1', 'Foo')
    expect(block?.id).toBe('page-1')
    expect(repo.find('page-1').dataSync()?.content).toBe('page content')
  })

  it('returns null when no row matches', async () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), makeUser())
    expect(await repo.findBlockByAliasInWorkspace('ws-1', 'Missing')).toBeNull()
  })
})

describe('Repo.findAliasMatchesInWorkspace', () => {
  it('returns rows of {alias, blockId, content}', async () => {
    const getAll = vi.fn(async (sql: string) => {
      if (/blocks\.id AS blockId/.test(sql)) {
        return [
          {alias: 'Foo', blockId: 'b1', content: 'foo content'},
          {alias: 'Foobar', blockId: 'b2', content: 'bar content'},
        ]
      }
      return []
    })
    const repo = new Repo(
      makeStubDb({getAll: getAll as PowerSyncDatabase['getAll']}),
      new UndoRedoManager(),
      makeUser(),
    )

    const rows = await repo.findAliasMatchesInWorkspace('ws-1', 'foo', 10)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({alias: 'Foo', blockId: 'b1', content: 'foo content'})
    const calls = findCalls(getAll, /blocks\.id AS blockId/)
    const [, params] = calls[0]
    expect(params).toEqual(['ws-1', 'foo', 'foo', 10])
  })
})

describe('Repo.searchBlocksByContent', () => {
  it('returns [] without hitting the DB on empty query', async () => {
    const getAll = vi.fn(async () => [])
    const repo = new Repo(
      makeStubDb({getAll: getAll as PowerSyncDatabase['getAll']}),
      new UndoRedoManager(),
      makeUser(),
    )

    const result = await repo.searchBlocksByContent('ws-1', '', 25)
    expect(result).toEqual([])
    const calls = findCalls(getAll, /content\s*!=\s*''/)
    expect(calls).toHaveLength(0)
  })

  it('passes workspaceId, query, and limit to the LIKE-based query', async () => {
    const getAll = vi.fn(async () => [])
    const repo = new Repo(
      makeStubDb({getAll: getAll as PowerSyncDatabase['getAll']}),
      new UndoRedoManager(),
      makeUser(),
    )

    await repo.searchBlocksByContent('ws-1', 'foo', 25)
    const calls = findCalls(getAll, /content\s*!=\s*''/)
    expect(calls).toHaveLength(1)
    const [, params] = calls[0]
    expect(params).toEqual(['ws-1', 'foo', 25])
  })

  it('hydrates the cache for matched blocks so repo.find(id) reads succeed', async () => {
    const match = blockData({
      id: 'matched',
      workspaceId: 'ws-1',
      content: 'has foo in it',
    })
    const getAll = vi.fn(async (sql: string) => {
      if (/content\s*!=\s*''/.test(sql)) return [toRow(match)]
      return []
    })
    const repo = new Repo(
      makeStubDb({getAll: getAll as PowerSyncDatabase['getAll']}),
      new UndoRedoManager(),
      makeUser(),
    )

    const result = await repo.searchBlocksByContent('ws-1', 'foo')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('matched')
    expect(repo.find('matched').dataSync()?.content).toBe('has foo in it')
  })
})
