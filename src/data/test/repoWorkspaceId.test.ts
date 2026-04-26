import { describe, it, expect } from 'vitest'
import { Repo } from '@/data/repo'
import { UndoRedoManager } from '@/data/undoRedo'
import type { PowerSyncDatabase } from '@powersync/web'
import type { BlockData, User } from '@/types'

// We exercise applyBlockChange's defensive workspace_id check without
// touching the storage layer. The Repo's BlockStorage / PowerSync trigger
// path runs in jsdom on a real PowerSyncDatabase in production; here we
// stub the db with no-ops so the cache + change-callback path can run in
// isolation.
const makeStubDb = (): PowerSyncDatabase => ({
  // Anything Repo touches in this test goes through the cache/storage
  // queue but the queue is fire-and-forget; failures inside it are caught
  // and logged. We just need the calls to not throw synchronously.
  onChange: () => () => {},
  writeLock: async () => undefined,
  getOptional: async () => null,
  getAll: async () => [],
  get: async () => ({seq: 0}),
  execute: async () => undefined,
}) as unknown as PowerSyncDatabase

const makeUser = (): User => ({id: 'user-1', name: 'Test'})

const seedSnapshot = (overrides: Partial<BlockData> = {}): BlockData => ({
  id: 'block-1',
  workspaceId: 'ws-1',
  content: '',
  properties: {},
  childIds: [],
  createTime: 0,
  updateTime: 0,
  createdByUserId: 'user-1',
  updatedByUserId: 'user-1',
  references: [],
  ...overrides,
})

describe('Repo.applyBlockChange workspace_id immutability', () => {
  it('throws when a callback mutates workspaceId', () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), makeUser())
    repo.hydrateBlockData(seedSnapshot())

    expect(() =>
      repo.applyBlockChange('block-1', (doc) => {
        doc.workspaceId = 'ws-2'
      }),
    ).toThrowError(/Cannot change workspaceId/)
  })

  it('allows changes that leave workspaceId untouched', () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), makeUser())
    repo.hydrateBlockData(seedSnapshot())

    expect(() =>
      repo.applyBlockChange('block-1', (doc) => {
        doc.content = 'updated'
      }),
    ).not.toThrow()

    expect(repo.getCachedBlockData('block-1')?.content).toBe('updated')
  })
})

describe('Repo.create workspaceId resolution', () => {
  it('throws when no workspaceId is provided and activeWorkspaceId is unset', () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), makeUser())
    expect(() => repo.create({content: 'hi'})).toThrowError(/Cannot create block/)
  })

  it('falls back to activeWorkspaceId', () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), makeUser())
    repo.setActiveWorkspaceId('ws-active')

    const block = repo.create({content: 'hi'})
    expect(repo.getCachedBlockData(block.id)?.workspaceId).toBe('ws-active')
  })

  it('explicit workspaceId in data overrides active workspace', () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), makeUser())
    repo.setActiveWorkspaceId('ws-active')

    const block = repo.create({content: 'hi', workspaceId: 'ws-explicit'})
    expect(repo.getCachedBlockData(block.id)?.workspaceId).toBe('ws-explicit')
  })
})
