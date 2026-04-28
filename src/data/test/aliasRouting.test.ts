import { describe, it, expect, vi } from 'vitest'
import type { PowerSyncDatabase } from '@powersync/web'
import { Repo } from '@/data/repo'
import { UndoRedoManager } from '@/data/undoRedo'
import { getOrCreateBlockForAlias } from '@/data/block'
import { dailyNoteBlockId, journalBlockId } from '@/data/dailyNotes'
import type { User } from '@/types'

const makeStubDb = (): PowerSyncDatabase =>
  ({
    onChange: () => () => {},
    writeLock: async () => undefined,
    getOptional: async () => null,
    getAll: async () => [],
    get: async () => ({seq: 0}),
    execute: async () => undefined,
  }) as unknown as PowerSyncDatabase

const makeUser = (): User => ({id: 'user-1', name: 'Test'})

const makeRepo = () => {
  const repo = new Repo(makeStubDb(), new UndoRedoManager(), makeUser())
  repo.setActiveWorkspaceId('ws-1')
  return repo
}

describe('getOrCreateBlockForAlias date routing', () => {
  it('routes ISO-shaped aliases to the deterministic daily-note id', async () => {
    const repo = makeRepo()
    const owner = repo.create({workspaceId: 'ws-1', content: ''})

    const resolved = await getOrCreateBlockForAlias(owner, '2026-04-28')

    expect(resolved.id).toBe(dailyNoteBlockId('ws-1', '2026-04-28'))
    expect(resolved.dataSync()?.parentId).toBe(journalBlockId('ws-1'))
  })

  it('routes weekday aliases through the daily-note path', async () => {
    const repo = makeRepo()
    const owner = repo.create({workspaceId: 'ws-1', content: ''})
    // Pin "now" so the test is deterministic.
    vi.setSystemTime(new Date(2026, 3, 28, 12)) // Tuesday 2026-04-28
    try {
      const resolved = await getOrCreateBlockForAlias(owner, 'Friday')
      // Friday after 2026-04-28 is 2026-05-01.
      expect(resolved.id).toBe(dailyNoteBlockId('ws-1', '2026-05-01'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('two date references — same iso, different syntax — collapse onto the same block', async () => {
    const repo = makeRepo()
    const owner = repo.create({workspaceId: 'ws-1', content: ''})
    vi.setSystemTime(new Date(2026, 3, 28, 12))
    try {
      const a = await getOrCreateBlockForAlias(owner, 'today')
      const b = await getOrCreateBlockForAlias(owner, '2026-04-28')
      expect(a.id).toBe(b.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('non-date aliases still go through the original parent-less create path', async () => {
    const repo = makeRepo()
    const owner = repo.create({workspaceId: 'ws-1', content: ''})

    const resolved = await getOrCreateBlockForAlias(owner, 'Foobar')

    expect(resolved.id).not.toBe(dailyNoteBlockId('ws-1', '2026-04-28'))
    expect(resolved.dataSync()?.parentId).toBeUndefined()
    expect(resolved.dataSync()?.content).toBe('Foobar')
  })
})
