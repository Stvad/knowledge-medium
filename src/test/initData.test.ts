import { describe, expect, it } from 'vitest'
import type { PowerSyncDatabase } from '@powersync/web'
import { Repo } from '@/data/repo'
import { UndoRedoManager } from '@/data/undoRedo'
import { seedDailyPage, seedTutorial } from '@/initData'

const makeStubDb = (): PowerSyncDatabase =>
  ({
    onChange: () => () => {},
    writeLock: async () => undefined,
    getOptional: async () => null,
    getAll: async () => [],
    get: async () => ({seq: 0}),
    execute: async () => undefined,
  }) as unknown as PowerSyncDatabase

describe('seedDailyPage', () => {
  it('seeds a date-aliased root with a single empty child', () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), {id: 'u', name: 'Test'})
    const rootId = 'root-2'

    seedDailyPage(repo, rootId, 'ws-1')

    const root = repo.getCachedBlockData(rootId)!
    expect(root.childIds).toHaveLength(1)
    const aliasValue = root.properties.alias?.value
    expect(Array.isArray(aliasValue)).toBe(true)
    expect((aliasValue as string[]).length).toBe(2)

    const child = repo.getCachedBlockData(root.childIds[0])
    expect(child?.content).toBe('')
  })

  it('places preface bullets above the empty typing bullet', () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), {id: 'u', name: 'Test'})
    const rootId = 'root-3'

    seedDailyPage(repo, rootId, 'ws-1', ['[[Tutorial]]'])

    const root = repo.getCachedBlockData(rootId)!
    expect(root.childIds).toHaveLength(2)
    expect(repo.getCachedBlockData(root.childIds[0])?.content).toBe('[[Tutorial]]')
    expect(repo.getCachedBlockData(root.childIds[1])?.content).toBe('')
  })
})

describe('seedTutorial', () => {
  it('creates a parent-less Tutorial root, separate from any caller-supplied id', () => {
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

  it('does not touch the daily-note seed root id (so getOrCreateDailyNote still finds an empty seed there)', () => {
    const repo = new Repo(makeStubDb(), new UndoRedoManager(), {id: 'u', name: 'Test'})

    const dailySeedId = 'daily-seed-uuid'
    repo.create({id: dailySeedId, workspaceId: 'ws-1', content: ''})

    seedTutorial(repo, 'ws-1')

    const seed = repo.getCachedBlockData(dailySeedId)
    expect(seed?.content).toBe('')
    expect(seed?.childIds).toEqual([])
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
