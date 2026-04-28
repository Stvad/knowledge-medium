import { describe, it, expect } from 'vitest'
import { Repo } from '@/data/repo'
import { UndoRedoManager } from '@/data/undoRedo'
import { blockToRowParams } from '@/data/blockSchema'
import type { PowerSyncDatabase } from '@powersync/web'
import type { BlockData, User } from '@/types'

// Mirrors the powersync row shape so the stubbed db.getAll can hand
// realistic data to BlockStorage.parseBlockRow.
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

interface CapturedUpsert {
  id: string
  deleted: 0 | 1
  childIdsJson: string
}

// Captures every UPSERT INTO blocks the storage layer queues. We assert
// against the deleted column directly — the cache snapshots tell the same
// story but going through the wire format catches encoding regressions
// (e.g. forgetting the deleted column in blockToRowParams).
const makeStubDb = (
  subtreeRows: ReturnType<typeof toRow>[],
  upserts: CapturedUpsert[],
): PowerSyncDatabase => ({
  onChange: () => () => {},
  writeLock: async (cb: (tx: {
    execute: (sql: string, params?: unknown[]) => Promise<unknown>,
  }) => Promise<unknown>) => {
    let pendingId: string | null = null
    let pendingChildIdsJson: string | null = null
    let pendingDeleted: 0 | 1 | null = null
    await cb({
      execute: async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO blocks') && params) {
          pendingId = params[0] as string
          pendingChildIdsJson = params[4] as string
          pendingDeleted = params[11] as 0 | 1
        }
        return undefined
      },
    })
    if (pendingId !== null && pendingDeleted !== null && pendingChildIdsJson !== null) {
      upserts.push({
        id: pendingId,
        deleted: pendingDeleted,
        childIdsJson: pendingChildIdsJson,
      })
    }
  },
  getOptional: async () => null,
  getAll: async (sql: string) => {
    // BlockStorage.loadSubtree runs the recursive subtree CTE
    // (buildSelectSubtreeBlocksSql). Pattern-match it and return the
    // canned rows so Repo.getSubtreeBlocks can hydrate descendants.
    if (typeof sql === 'string' && sql.includes('WITH RECURSIVE subtree')) {
      return subtreeRows
    }
    return []
  },
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

const flushQueue = () => new Promise<void>(resolve => queueMicrotask(resolve))

describe('Block.delete', () => {
  it('marks a leaf block deleted and removes it from the parent\'s childIds', async () => {
    const parent = blockData({id: 'parent', childIds: ['leaf']})
    const leaf = blockData({id: 'leaf', parentId: 'parent'})

    const upserts: CapturedUpsert[] = []
    const db = makeStubDb([toRow(leaf)], upserts)
    const repo = new Repo(db, new UndoRedoManager(), makeUser())

    repo.hydrateBlockData(parent)
    repo.hydrateBlockData(leaf)

    await repo.find('leaf').delete()
    await flushQueue()
    await repo.flush()

    expect(repo.getCachedBlockData('leaf')?.deleted).toBe(true)
    expect(repo.getCachedBlockData('parent')?.childIds).toEqual([])

    const leafUpsert = upserts.find(u => u.id === 'leaf')
    expect(leafUpsert?.deleted).toBe(1)
    const parentUpsert = upserts.find(u => u.id === 'parent')
    expect(parentUpsert?.childIdsJson).toBe('[]')
  })

  it('marks every descendant deleted, not just the root of the subtree', async () => {
    // root → mid → leaf. Deleting `mid` must flag both mid and leaf so
    // workspace-wide queries (findBlocksByType) skip leaf too — otherwise
    // a deleted folder of extension blocks would still register facets.
    const root = blockData({id: 'root', childIds: ['mid']})
    const mid = blockData({id: 'mid', parentId: 'root', childIds: ['leaf']})
    const leaf = blockData({id: 'leaf', parentId: 'mid'})

    const upserts: CapturedUpsert[] = []
    const db = makeStubDb([toRow(mid), toRow(leaf)], upserts)
    const repo = new Repo(db, new UndoRedoManager(), makeUser())

    repo.hydrateBlockData(root)
    repo.hydrateBlockData(mid)
    repo.hydrateBlockData(leaf)

    await repo.find('mid').delete()
    await flushQueue()
    await repo.flush()

    expect(repo.getCachedBlockData('mid')?.deleted).toBe(true)
    expect(repo.getCachedBlockData('leaf')?.deleted).toBe(true)
    expect(repo.getCachedBlockData('root')?.deleted).toBe(false)

    expect(upserts.find(u => u.id === 'mid')?.deleted).toBe(1)
    expect(upserts.find(u => u.id === 'leaf')?.deleted).toBe(1)
  })

  it('is a no-op for a root block (no parent)', async () => {
    // Root blocks (parent_id IS NULL) have no parent to splice from. The
    // current implementation early-returns rather than orphaning the
    // workspace, so the row stays untouched.
    const root = blockData({id: 'root'})

    const upserts: CapturedUpsert[] = []
    const db = makeStubDb([], upserts)
    const repo = new Repo(db, new UndoRedoManager(), makeUser())

    repo.hydrateBlockData(root)

    await repo.find('root').delete()
    await flushQueue()
    await repo.flush()

    expect(repo.getCachedBlockData('root')?.deleted).toBe(false)
    expect(upserts).toEqual([])
  })
})
