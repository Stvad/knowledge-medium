// @vitest-environment node
/**
 * Daily-note domain helper tests (spec §7.6, §10.4). Covers the two
 * exported helpers that own the journal page + its dated children:
 *   - getOrCreateJournalBlock — workspace-singleton journal page,
 *     deterministic id derived from (JOURNAL_NS, workspaceId).
 *   - getOrCreateDailyNote — one row per (workspaceId, iso) under the
 *     journal, deterministic id derived from (DAILY_NOTE_NS,
 *     `${workspaceId}:${iso}`).
 *
 * These rebuild the behaviors covered by the deleted
 * `dailyNotes.test.ts` against the new tx-engine APIs (tx.create /
 * tx.restore / tx.move) and `createTestDb` harness.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { aliasesProp, typeProp } from '@/data/properties'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import {
  DAILY_NOTE_NS,
  JOURNAL_NS,
  addDaysIso,
  dailyNoteBlockId,
  getOrCreateDailyNote,
  getOrCreateJournalBlock,
  journalBlockId,
} from '@/data/dailyNotes'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  cache: BlockCache
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
  })
  return {h, cache, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

describe('deterministic ids', () => {
  it('journalBlockId is stable for a given workspace', () => {
    expect(journalBlockId('ws-1')).toBe(journalBlockId('ws-1'))
    expect(journalBlockId('ws-1')).not.toBe(journalBlockId('ws-2'))
  })

  it('dailyNoteBlockId is stable per (workspace, iso)', () => {
    expect(dailyNoteBlockId('ws-1', '2026-04-28')).toBe(dailyNoteBlockId('ws-1', '2026-04-28'))
    expect(dailyNoteBlockId('ws-1', '2026-04-28')).not.toBe(dailyNoteBlockId('ws-1', '2026-04-29'))
    expect(dailyNoteBlockId('ws-1', '2026-04-28')).not.toBe(dailyNoteBlockId('ws-2', '2026-04-28'))
  })

  it('namespace constants are pinned', () => {
    // Mirrored by the supabase migration; drift between the two
    // reintroduces the per-client duplicate-page bug.
    expect(JOURNAL_NS).toBe('a304a5da-807a-4c20-8af3-53a033aa9df8')
    expect(DAILY_NOTE_NS).toBe('53421e08-2f31-42f8-b73a-43830bb718f1')
  })
})

describe('addDaysIso', () => {
  it('moves across month and year boundaries using local calendar dates', () => {
    expect(addDaysIso('2026-05-01', -1)).toBe('2026-04-30')
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('handles leap days', () => {
    expect(addDaysIso('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDaysIso('2024-03-01', -1)).toBe('2024-02-29')
  })
})

describe('getOrCreateJournalBlock', () => {
  it('creates a parent-less journal with the canonical alias + type', async () => {
    const journal = await getOrCreateJournalBlock(env.repo, WS)

    expect(journal.id).toBe(journalBlockId(WS))
    const data = journal.peek()
    expect(data?.parentId).toBeNull()
    expect(data?.workspaceId).toBe(WS)
    expect(data?.content).toBe('Journal')
    expect(journal.peekProperty(aliasesProp)).toEqual(['Journal'])
    expect(journal.peekProperty(typeProp)).toBe('journal')
  })

  it('is idempotent: second call returns the same row, no duplicate', async () => {
    const a = await getOrCreateJournalBlock(env.repo, WS)
    const b = await getOrCreateJournalBlock(env.repo, WS)
    expect(a.id).toBe(b.id)

    const rows = await env.h.db.getAll<{count: number}>(
      'SELECT COUNT(*) AS count FROM blocks WHERE id = ? AND deleted = 0',
      [a.id],
    )
    expect(rows[0]?.count).toBe(1)
  })

  it('resurrects a soft-deleted journal row', async () => {
    const journal = await getOrCreateJournalBlock(env.repo, WS)
    await env.repo.tx(tx => tx.delete(journal.id), {scope: ChangeScope.BlockDefault})

    const restored = await getOrCreateJournalBlock(env.repo, WS)
    expect(restored.id).toBe(journal.id)
    expect(restored.peek()?.deleted).toBe(false)
    expect(restored.peekProperty(aliasesProp)).toEqual(['Journal'])
    expect(restored.peekProperty(typeProp)).toBe('journal')
  })
})

describe('getOrCreateDailyNote', () => {
  const ISO = '2026-04-28'

  it('creates a daily note parented to the journal with both aliases', async () => {
    const note = await getOrCreateDailyNote(env.repo, WS, ISO)

    expect(note.id).toBe(dailyNoteBlockId(WS, ISO))
    const data = note.peek()
    expect(data?.parentId).toBe(journalBlockId(WS))
    expect(data?.workspaceId).toBe(WS)
    expect(note.peekProperty(typeProp)).toBe('daily-note')

    const aliases = note.peekProperty(aliasesProp)
    expect(aliases).toHaveLength(2)
    expect(aliases?.[1]).toBe(ISO)
    // Long alias is the locale-formatted day; checked loosely so a
    // tz-edge change in dailyPageAliases doesn't fight this test.
    expect(aliases?.[0]).toMatch(/2026/)
  })

  it('links the daily note as a child of the journal', async () => {
    const note = await getOrCreateDailyNote(env.repo, WS, ISO)
    const journalId = journalBlockId(WS)
    const journal = await env.repo.load(journalId, {children: true})
    expect(journal).not.toBeNull()
    const childIds = await env.repo.block(journalId).childIds.load()
    expect(childIds).toContain(note.id)
  })

  it('is idempotent: second call returns the same row, no duplicate', async () => {
    const a = await getOrCreateDailyNote(env.repo, WS, ISO)
    const b = await getOrCreateDailyNote(env.repo, WS, ISO)
    expect(a.id).toBe(b.id)

    const rows = await env.h.db.getAll<{count: number}>(
      'SELECT COUNT(*) AS count FROM blocks WHERE id = ?',
      [a.id],
    )
    expect(rows[0]?.count).toBe(1)
  })

  it('two distinct iso days produce two distinct rows under the same journal', async () => {
    const a = await getOrCreateDailyNote(env.repo, WS, '2026-04-28')
    const b = await getOrCreateDailyNote(env.repo, WS, '2026-04-29')
    expect(a.id).not.toBe(b.id)

    const journalId = journalBlockId(WS)
    await env.repo.load(journalId, {children: true})
    const childIds = await env.repo.block(journalId).childIds.load()
    expect(childIds).toEqual(expect.arrayContaining([a.id, b.id]))
  })

  it('resurrects a soft-deleted daily note and re-parents under the journal', async () => {
    const note = await getOrCreateDailyNote(env.repo, WS, ISO)
    await env.repo.tx(tx => tx.delete(note.id), {scope: ChangeScope.BlockDefault})

    const restored = await getOrCreateDailyNote(env.repo, WS, ISO)
    expect(restored.id).toBe(note.id)
    expect(restored.peek()?.deleted).toBe(false)
    expect(restored.peek()?.parentId).toBe(journalBlockId(WS))
    expect(restored.peekProperty(typeProp)).toBe('daily-note')
  })
})
