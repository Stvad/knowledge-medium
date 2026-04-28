import { describe, expect, it } from 'vitest'
import type { PowerSyncDatabase } from '@powersync/web'
import { Repo } from '@/data/repo'
import { UndoRedoManager } from '@/data/undoRedo'
import { seedNewWorkspace } from '@/initData'

const makeStubDb = (): PowerSyncDatabase =>
  ({
    onChange: () => () => {},
    writeLock: async () => undefined,
    getOptional: async () => null,
    getAll: async () => [],
    get: async () => ({seq: 0}),
    execute: async () => undefined,
  }) as unknown as PowerSyncDatabase

describe('seedNewWorkspace — tutorial', () => {
  it('seeds the root + intro + sample + extensions subtree', () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), {id: 'u', name: 'Test'})
    const rootId = 'root-1'

    seedNewWorkspace(repo, rootId, 'ws-1', 'tutorial')

    const root = repo.getCachedBlockData(rootId)
    expect(root).toBeDefined()
    expect(root!.content).toBe('Welcome')
    expect(root!.childIds).toHaveLength(3)
    expect(root!.workspaceId).toBe('ws-1')
  })

  it('creates four extension blocks under a parent labeled "extensions"', () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), {id: 'u', name: 'Test'})
    const rootId = 'root-1'

    seedNewWorkspace(repo, rootId, 'ws-1', 'tutorial')

    const root = repo.getCachedBlockData(rootId)!
    // The extensions parent is the third child of root in the seed.
    const extensionsParentId = root.childIds[2]
    const extensionsParent = repo.getCachedBlockData(extensionsParentId)
    expect(extensionsParent).toBeDefined()
    expect(extensionsParent!.content).toBe('extensions')
    expect(extensionsParent!.childIds).toHaveLength(4)

    // Each child should be type='extension'.
    for (const childId of extensionsParent!.childIds) {
      const child = repo.getCachedBlockData(childId)
      expect(child?.properties.type?.value).toBe('extension')
      expect(child?.workspaceId).toBe('ws-1')
    }
  })

  it('seeds an example block that references the hello-renderer extension', () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), {id: 'u', name: 'Test'})
    const rootId = 'root-1'

    seedNewWorkspace(repo, rootId, 'ws-1', 'tutorial')

    const root = repo.getCachedBlockData(rootId)!
    const sampleId = root.childIds[1]
    const sample = repo.getCachedBlockData(sampleId)
    expect(sample?.properties.renderer?.value).toBe('hello-renderer')
  })
})

describe('seedNewWorkspace — daily', () => {
  it('seeds a date-aliased root with a single empty child', () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), {id: 'u', name: 'Test'})
    const rootId = 'root-2'

    seedNewWorkspace(repo, rootId, 'ws-1', 'daily')

    const root = repo.getCachedBlockData(rootId)!
    expect(root.childIds).toHaveLength(1)
    const aliasValue = root.properties.alias?.value
    expect(Array.isArray(aliasValue)).toBe(true)
    expect((aliasValue as string[]).length).toBe(2)

    const child = repo.getCachedBlockData(root.childIds[0])
    expect(child?.content).toBe('')
  })
})
