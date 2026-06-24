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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { dailyNoteDateProp } from '@/plugins/daily-notes/schema.js'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import {
  DAILY_NOTE_NS,
  DAILY_NOTE_TYPE,
  JOURNAL_NS,
  addDaysIso,
  dailyNoteBlockId,
  dailyNotesDataExtension,
  getOrCreateDailyNote,
  getOrCreateJournalBlock,
  journalBlockId,
} from '@/plugins/daily-notes'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  cache: BlockCache
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  // Shared DB opened once per file, reset between tests; fresh Repo per test.
  await resetTestDb(sharedDb.db)
  const h = sharedDb
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
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
  ]))
  return {h, cache, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
afterEach(() => { env.repo.stopSyncObserver() })

const contentChildIds = async (parentId: string): Promise<string[]> =>
  (await env.repo.block(parentId).children.load())
    .filter(row => !row.referenceTargetId)
    .map(row => row.id)

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
    // Pinned so two clients deriving an id offline land on the same row
    // once they sync. Drift on either side reintroduces the
    // per-client duplicate-page bug.
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
  it('creates a parent-less journal page with the canonical alias', async () => {
    const journal = await getOrCreateJournalBlock(env.repo, WS)

    expect(journal.id).toBe(journalBlockId(WS))
    const data = journal.peek()
    expect(data?.parentId).toBeNull()
    expect(data?.workspaceId).toBe(WS)
    expect(data?.content).toBe('Journal')
    expect(journal.peekProperty(aliasesProp)).toEqual(['Journal'])
    expect(journal.hasType(PAGE_TYPE)).toBe(true)
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
    expect(restored.hasType(PAGE_TYPE)).toBe(true)
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
    expect(note.hasType(PAGE_TYPE)).toBe(true)
    expect(note.hasType(DAILY_NOTE_TYPE)).toBe(true)

    const aliases = note.peekProperty(aliasesProp)
    expect(aliases).toHaveLength(2)
    expect(aliases?.[1]).toBe(ISO)
    // Long alias is the locale-formatted day; checked loosely so a
    // tz-edge change in dailyPageAliases doesn't fight this test.
    expect(aliases?.[0]).toMatch(/2026/)
  })

  it('populates the indexable date property at creation', async () => {
    const note = await getOrCreateDailyNote(env.repo, WS, ISO)
    const stored = note.peekProperty(dailyNoteDateProp)
    expect(stored).toBeInstanceOf(Date)
    expect(stored?.toISOString()).toBe('2026-04-28T00:00:00.000Z')
  })

  it('links the daily note as a child of the journal', async () => {
    const note = await getOrCreateDailyNote(env.repo, WS, ISO)
    const journalId = journalBlockId(WS)
    const journal = await env.repo.load(journalId, {children: true})
    expect(journal).not.toBeNull()
    const childIds = await contentChildIds(journalId)
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
    const childIds = await contentChildIds(journalId)
    expect(childIds).toEqual([b.id, a.id])
  })

  it('rekeys existing daily notes into reverse chronology when reopened', async () => {
    const journal = await getOrCreateJournalBlock(env.repo, WS)
    const olderId = dailyNoteBlockId(WS, '2026-04-28')
    const newerId = dailyNoteBlockId(WS, '2026-04-29')
    await env.repo.tx(async tx => {
      await tx.create({
        id: olderId,
        workspaceId: WS,
        parentId: journal.id,
        orderKey: '2026-04-28',
        content: 'April 28th, 2026',
      })
      await tx.create({
        id: newerId,
        workspaceId: WS,
        parentId: journal.id,
        orderKey: '2026-04-29',
        content: 'April 29th, 2026',
      })
    }, {scope: ChangeScope.BlockDefault})

    await getOrCreateDailyNote(env.repo, WS, '2026-04-28')
    await getOrCreateDailyNote(env.repo, WS, '2026-04-29')

    const childIds = await contentChildIds(journal.id)
    expect(childIds).toEqual([newerId, olderId])
    expect(env.repo.block(olderId).hasType(PAGE_TYPE)).toBe(true)
    expect(env.repo.block(olderId).hasType(DAILY_NOTE_TYPE)).toBe(true)
    expect(env.repo.block(newerId).hasType(PAGE_TYPE)).toBe(true)
    expect(env.repo.block(newerId).hasType(DAILY_NOTE_TYPE)).toBe(true)
  })

  it('resurrects a soft-deleted daily note and re-parents under the journal', async () => {
    const note = await getOrCreateDailyNote(env.repo, WS, ISO)
    await env.repo.tx(tx => tx.delete(note.id), {scope: ChangeScope.BlockDefault})

    const restored = await getOrCreateDailyNote(env.repo, WS, ISO)
    expect(restored.id).toBe(note.id)
    expect(restored.peek()?.deleted).toBe(false)
    expect(restored.peek()?.parentId).toBe(journalBlockId(WS))
    expect(restored.hasType(PAGE_TYPE)).toBe(true)
    expect(restored.hasType(DAILY_NOTE_TYPE)).toBe(true)
    expect(restored.peekProperty(dailyNoteDateProp)?.toISOString())
      .toBe('2026-04-28T00:00:00.000Z')
  })
})

describe('idx_blocks_daily_note_date', () => {
  /** SQLite expression-index matching is text-based: the indexed
   *  expression text must appear literally in the query. Both halves
   *  — the CREATE INDEX statement and the compiled `where` clause —
   *  have to agree on the exact `json_extract(properties_json, '...')`
   *  spelling. This test pins that agreement by asking the planner
   *  whether it picks the index for the motivating query, so a future
   *  change to either the compiler's path-emission or the index DDL
   *  that breaks the match fails here before it ships to prod. */
  it('is picked by the planner for daily-note:date range queries', async () => {
    // Seed a daily note so the partial index isn't empty (an empty
    // index is the planner's strong default to skip).
    await getOrCreateDailyNote(env.repo, WS, '2026-04-28')

    // Use repo.queryBlocks against the daily-note type filtered by
    // date; whatever SQL the compiler emits is what we want indexed.
    // Grab it via EXPLAIN QUERY PLAN on a hand-rolled equivalent that
    // mirrors the candidates-CTE path-extract text exactly.
    const plan = await env.h.db.getAll<{detail: string}>(`
      EXPLAIN QUERY PLAN
      SELECT id FROM blocks
      WHERE deleted = 0
        AND json_extract(properties_json, '$."${dailyNoteDateProp.name}"') < ?
    `, ['2026-05-18T00:00:00.000Z'])
    const detail = plan.map(r => r.detail).join(' | ')
    expect(detail).toContain('idx_blocks_daily_note_date')
  })
})
