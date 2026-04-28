import { describe, it, expect, vi } from 'vitest'
import { Repo } from '@/data/repo'
import { UndoRedoManager } from '@/data/undoRedo'
import { isEditingProp, setIsEditing, uiChangeScope } from '@/data/properties'
import type { PowerSyncDatabase } from '@powersync/web'
import type { BlockData, User } from '@/types'

interface CapturedWrite {
  id: string
  source: string
}

const makeStubDb = (writes: CapturedWrite[]): PowerSyncDatabase => ({
  onChange: () => () => {},
  // The storage layer wraps every upsert in writeLock + an event_context
  // INSERT. We capture the (id, source) tuple to assert ephemerality.
  writeLock: async (cb: (tx: {
    execute: (sql: string, params?: unknown[]) => Promise<unknown>,
  }) => Promise<unknown>) => {
    let pendingSource: string | null = null
    let pendingId: string | null = null
    await cb({
      execute: async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO block_event_context') && params) {
          pendingSource = params[1] as string
        }
        if (sql.includes('INSERT INTO blocks') && params) {
          pendingId = params[0] as string
        }
        return undefined
      },
    })
    if (pendingId && pendingSource) {
      writes.push({id: pendingId, source: pendingSource})
    }
  },
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
  deleted: false,
  ...overrides,
})

const flushQueue = () => new Promise<void>(resolve => queueMicrotask(resolve))

describe('Repo read-only mode', () => {
  it('warns and routes non-ui-scope changes to ephemeral instead of throwing', async () => {
    const writes: CapturedWrite[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const repo = new Repo(makeStubDb(writes), new UndoRedoManager(), makeUser())
    repo.hydrateBlockData(seedSnapshot())
    repo.setReadOnly(true)

    expect(() =>
      repo.applyBlockChange('block-1', (doc) => {
        doc.content = 'edit'
      }),
    ).not.toThrow()

    await repo.flush()
    await flushQueue()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[readonly]'))
    expect(writes).toEqual([{id: 'block-1', source: 'local-ephemeral'}])
    warn.mockRestore()
  })

  it('routes ui-scope changes to ephemeral source without warning', async () => {
    const writes: CapturedWrite[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const repo = new Repo(makeStubDb(writes), new UndoRedoManager(), makeUser())
    repo.hydrateBlockData(seedSnapshot())
    repo.setReadOnly(true)

    repo.applyBlockChange('block-1', (doc) => {
      doc.properties.foo = {name: 'foo', type: 'string', value: 'bar'}
    }, {scope: uiChangeScope})

    await repo.flush()
    await flushQueue()

    expect(repo.getCachedBlockData('block-1')?.properties.foo?.value).toBe('bar')
    expect(writes).toEqual([{id: 'block-1', source: 'local-ephemeral'}])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('warns and routes non-ui-scope creates to ephemeral instead of throwing', async () => {
    const writes: CapturedWrite[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const repo = new Repo(makeStubDb(writes), new UndoRedoManager(), makeUser())
    repo.setActiveWorkspaceId('ws-1')
    repo.setReadOnly(true)

    expect(() => repo.create({content: 'new'})).not.toThrow()

    await repo.flush()
    await flushQueue()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[readonly]'))
    expect(writes.length).toBe(1)
    expect(writes[0].source).toBe('local-ephemeral')
    warn.mockRestore()
  })

  it('routes ui-scope creates to ephemeral source without warning', async () => {
    const writes: CapturedWrite[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const repo = new Repo(makeStubDb(writes), new UndoRedoManager(), makeUser())
    repo.setActiveWorkspaceId('ws-1')
    repo.setReadOnly(true)

    const block = repo.create({content: 'ui'}, {scope: uiChangeScope})

    await repo.flush()
    await flushQueue()

    expect(writes).toEqual([{id: block.id, source: 'local-ephemeral'}])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not record ephemeral changes in undo history', () => {
    const undo = new UndoRedoManager()
    const recordSpy = vi.spyOn(undo, 'recordChange')
    const repo = new Repo(makeStubDb([]), undo, makeUser())
    repo.hydrateBlockData(seedSnapshot())
    repo.setReadOnly(true)

    repo.applyBlockChange('block-1', (doc) => {
      doc.properties.foo = {name: 'foo', type: 'string', value: 'bar'}
    }, {scope: uiChangeScope})

    expect(recordSpy).toHaveBeenCalledWith(
      'block-1',
      expect.anything(),
      expect.anything(),
      expect.objectContaining({skipUndo: true}),
    )
  })

  it('refuses setIsEditing(true) when read-only', () => {
    const repo = new Repo(makeStubDb([]), new UndoRedoManager(), makeUser())
    repo.hydrateBlockData(seedSnapshot())
    repo.setReadOnly(true)

    const uiStateBlock = repo.find('block-1')
    setIsEditing(uiStateBlock, true)

    // The set was a no-op — the property never landed on the cached snapshot.
    expect(repo.getCachedBlockData('block-1')?.properties[isEditingProp.name]).toBeUndefined()
  })

  it('allows setIsEditing(false) even when read-only', () => {
    const repo = new Repo(makeStubDb([]), new UndoRedoManager(), makeUser())
    repo.hydrateBlockData(seedSnapshot({
      properties: {[isEditingProp.name]: {...isEditingProp, value: true}},
    }))
    repo.setReadOnly(true)

    const uiStateBlock = repo.find('block-1')
    setIsEditing(uiStateBlock, false)

    expect(repo.getCachedBlockData('block-1')?.properties[isEditingProp.name]?.value).toBe(false)
  })

  it('uses local source when not read-only', async () => {
    const writes: CapturedWrite[] = []
    const repo = new Repo(makeStubDb(writes), new UndoRedoManager(), makeUser())
    repo.hydrateBlockData(seedSnapshot())

    repo.applyBlockChange('block-1', (doc) => {
      doc.content = 'edit'
    })

    await repo.flush()
    await flushQueue()

    expect(writes).toEqual([{id: 'block-1', source: 'local'}])
  })
})
