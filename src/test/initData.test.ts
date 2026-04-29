import { describe, expect, it } from 'vitest'
import type { PowerSyncDatabase } from '@powersync/web'
import { Repo } from '@/data/repo'
import { UndoRedoManager } from '@/data/undoRedo'
import { seedTutorial } from '@/initData'

const makeStubDb = (): PowerSyncDatabase =>
  ({
    onChange: () => () => {},
    writeLock: async () => undefined,
    getOptional: async () => null,
    getAll: async () => [],
    get: async () => ({seq: 0}),
    execute: async () => undefined,
  }) as unknown as PowerSyncDatabase

describe('seedTutorial', () => {
  it('creates a parent-less Tutorial page', () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), {id: 'u', name: 'Test'})

    const tutorialRootId = seedTutorial(repo, 'ws-1')

    const root = repo.getCachedBlockData(tutorialRootId)
    expect(root).toBeDefined()
    expect(root!.parentId).toBeUndefined()
    expect(root!.content).toBe('Tutorial')
    expect(root!.workspaceId).toBe('ws-1')
    expect(root!.properties.alias?.value).toEqual(['Tutorial'])
    expect(root!.childIds).toHaveLength(3)
  })

  it('creates four extension blocks under a parent labeled "extensions"', () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), {id: 'u', name: 'Test'})

    const tutorialRootId = seedTutorial(repo, 'ws-1')

    const root = repo.getCachedBlockData(tutorialRootId)!
    // The extensions parent is the third child of root in the seed.
    const extensionsParentId = root.childIds[2]
    const extensionsParent = repo.getCachedBlockData(extensionsParentId)
    expect(extensionsParent).toBeDefined()
    expect(extensionsParent!.content).toBe('extensions')
    expect(extensionsParent!.childIds).toHaveLength(4)

    for (const childId of extensionsParent!.childIds) {
      const child = repo.getCachedBlockData(childId)
      expect(child?.properties.type?.value).toBe('extension')
      expect(child?.workspaceId).toBe('ws-1')
    }
  })

  it('seeds an example block that references the hello-renderer extension', () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), {id: 'u', name: 'Test'})

    const tutorialRootId = seedTutorial(repo, 'ws-1')

    const root = repo.getCachedBlockData(tutorialRootId)!
    const sampleId = root.childIds[1]
    const sample = repo.getCachedBlockData(sampleId)
    expect(sample?.properties.renderer?.value).toBe('hello-renderer')
  })
})
