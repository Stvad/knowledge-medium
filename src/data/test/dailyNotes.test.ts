import { describe, it, expect, vi } from 'vitest'
import type { PowerSyncDatabase } from '@powersync/web'
import { Repo } from '@/data/repo'
import { UndoRedoManager } from '@/data/undoRedo'
import { blockToRowParams } from '@/data/blockSchema'
import {
  dailyNoteBlockId,
  findDailyNote,
  getOrCreateDailyNote,
  getOrCreateJournalBlock,
  journalBlockId,
} from '@/data/dailyNotes'
import { aliasProp, fromList, typeProp } from '@/data/properties'
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

const stubReposity = (
  rowsById: Map<string, BlockData> = new Map(),
) => {
  const getOptional = vi.fn(async (sql: string, params?: unknown[]) => {
    if (typeof sql === 'string' && /WHERE id = \?/.test(sql)) {
      const id = (params as string[])[0]
      const row = rowsById.get(id)
      return row ? toRow(row) : null
    }
    return null
  })
  const getAll = vi.fn(async () => [])
  const repo = new Repo(
    makeStubDb({
      getOptional: getOptional as PowerSyncDatabase['getOptional'],
      getAll: getAll as PowerSyncDatabase['getAll'],
    }),
    new UndoRedoManager(),
    makeUser(),
  )
  repo.setActiveWorkspaceId('ws-1')
  return {repo, rowsById}
}

describe('deterministic ids', () => {
  it('journalBlockId is stable for a given workspace', () => {
    const a = journalBlockId('ws-1')
    const b = journalBlockId('ws-1')
    expect(a).toBe(b)
    expect(a).not.toBe(journalBlockId('ws-2'))
  })

  it('dailyNoteBlockId is stable per (workspace, iso)', () => {
    const a = dailyNoteBlockId('ws-1', '2026-04-28')
    const b = dailyNoteBlockId('ws-1', '2026-04-28')
    expect(a).toBe(b)
    expect(a).not.toBe(dailyNoteBlockId('ws-1', '2026-04-29'))
    expect(a).not.toBe(dailyNoteBlockId('ws-2', '2026-04-28'))
  })
})

describe('getOrCreateJournalBlock', () => {
  it('creates a parent-less journal block on first call', async () => {
    const {repo} = stubReposity()
    const journal = await getOrCreateJournalBlock(repo, 'ws-1')
    const data = journal.dataSync()
    expect(journal.id).toBe(journalBlockId('ws-1'))
    expect(data?.parentId).toBeUndefined()
    expect(data?.workspaceId).toBe('ws-1')
    expect(data?.properties[aliasProp().name]?.value).toEqual(['Journal'])
    expect(data?.properties[typeProp.name]?.value).toBe('journal')
  })

  it('returns the same block on subsequent calls (in-cache)', async () => {
    const {repo} = stubReposity()
    const a = await getOrCreateJournalBlock(repo, 'ws-1')
    const b = await getOrCreateJournalBlock(repo, 'ws-1')
    expect(a.id).toBe(b.id)
  })

  it('resurrects a soft-deleted journal', async () => {
    const id = journalBlockId('ws-1')
    const stored = blockData({
      id,
      workspaceId: 'ws-1',
      properties: fromList(aliasProp(['Journal']), {...typeProp, value: 'journal'}),
      deleted: true,
    })
    const {repo} = stubReposity(new Map([[id, stored]]))

    const journal = await getOrCreateJournalBlock(repo, 'ws-1')
    expect(journal.dataSync()?.deleted).toBe(false)
  })
})

describe('getOrCreateDailyNote', () => {
  it('creates a daily note parented to the journal with both aliases', async () => {
    const {repo} = stubReposity()
    const note = await getOrCreateDailyNote(repo, 'ws-1', '2026-04-28')

    const data = note.dataSync()
    expect(note.id).toBe(dailyNoteBlockId('ws-1', '2026-04-28'))
    expect(data?.parentId).toBe(journalBlockId('ws-1'))
    expect(data?.properties[aliasProp().name]?.value).toEqual([
      'April 28th, 2026',
      '2026-04-28',
    ])
    expect(data?.properties[typeProp.name]?.value).toBe('daily-note')
    expect(data?.createTime).toBe(Date.parse('2026-04-28T00:00:00Z'))
  })

  it('links the daily note into the journal childIds', async () => {
    const {repo} = stubReposity()
    const note = await getOrCreateDailyNote(repo, 'ws-1', '2026-04-28')
    const journal = repo.find(journalBlockId('ws-1'))
    expect(journal.dataSync()?.childIds).toContain(note.id)
  })

  it('is idempotent: a second call returns the same block, no duplicate child link', async () => {
    const {repo} = stubReposity()
    await getOrCreateDailyNote(repo, 'ws-1', '2026-04-28')
    await getOrCreateDailyNote(repo, 'ws-1', '2026-04-28')
    const journal = repo.find(journalBlockId('ws-1'))
    const childIds = journal.dataSync()?.childIds ?? []
    const dailyId = dailyNoteBlockId('ws-1', '2026-04-28')
    expect(childIds.filter(c => c === dailyId)).toHaveLength(1)
  })

  it('two separate iso days produce two separate daily notes both linked to the journal', async () => {
    const {repo} = stubReposity()
    const a = await getOrCreateDailyNote(repo, 'ws-1', '2026-04-28')
    const b = await getOrCreateDailyNote(repo, 'ws-1', '2026-04-29')
    expect(a.id).not.toBe(b.id)
    const journal = repo.find(journalBlockId('ws-1'))
    expect(journal.dataSync()?.childIds).toEqual(
      expect.arrayContaining([a.id, b.id]),
    )
  })

  it('reuses an existing daily-aliased block found by alias instead of creating a duplicate', async () => {
    // A workspace seeder might install today's page under a server-supplied
    // UUID before we ever call getOrCreateDailyNote. Make sure the alias
    // lookup short-circuits and returns the seeded block.
    const {repo} = stubReposity()
    const seeded = repo.create({
      workspaceId: 'ws-1',
      content: 'April 28th, 2026',
      properties: fromList(aliasProp(['April 28th, 2026', '2026-04-28'])),
    })
    // Spy on the alias query to short-circuit it: stubReposity defaults to
    // returning null, but we want the spy to pretend the seeded row was
    // matched.
    vi.spyOn(repo, 'findBlockByAliasInWorkspace').mockResolvedValue(seeded)

    const note = await getOrCreateDailyNote(repo, 'ws-1', '2026-04-28')
    expect(note.id).toBe(seeded.id)
    expect(note.id).not.toBe(dailyNoteBlockId('ws-1', '2026-04-28'))
  })

  it('resurrects a soft-deleted daily note and re-links it under the journal', async () => {
    const id = dailyNoteBlockId('ws-1', '2026-04-28')
    const stored = blockData({
      id,
      workspaceId: 'ws-1',
      content: 'April 28th, 2026',
      // Pre-delete: parentId cleared and the journal has spliced it
      // out of childIds.
      parentId: undefined,
      properties: fromList(aliasProp(['April 28th, 2026', '2026-04-28'])),
      deleted: true,
    })
    const {repo} = stubReposity(new Map([[id, stored]]))

    const resurrected = await getOrCreateDailyNote(repo, 'ws-1', '2026-04-28')
    expect(resurrected.dataSync()?.deleted).toBe(false)
    expect(resurrected.dataSync()?.parentId).toBe(journalBlockId('ws-1'))
    const journal = repo.find(journalBlockId('ws-1'))
    expect(journal.dataSync()?.childIds).toContain(id)
  })
})

describe('findDailyNote', () => {
  it('delegates to repo.findBlockByAliasInWorkspace with the iso alias', async () => {
    const {repo} = stubReposity()
    const spy = vi.spyOn(repo, 'findBlockByAliasInWorkspace')
    await findDailyNote(repo, 'ws-1', '2026-04-28')
    expect(spy).toHaveBeenCalledWith('ws-1', '2026-04-28')
  })
})
