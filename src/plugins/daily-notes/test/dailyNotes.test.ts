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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { DeterministicIdCrossWorkspaceError } from '@/data/api/errors'
import { aliasesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { dailyNoteDateProp } from '@/plugins/daily-notes/schema.js'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { createTestRepo, isBlockDeleted } from '@/data/test/createTestRepo'
import {
  DAILY_NOTE_TYPE,
  addDaysIso,
  dailyNoteBlockId,
  dailyNotesDataExtension,
  getOrCreateDailyNote,
  getOrCreateJournalBlock,
  journalBlockId,
  todayIso,
} from '@/plugins/daily-notes'
import { todayDailyNoteLanding } from '@/plugins/daily-notes/landing.js'

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
  const { repo, cache } = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
    extensions: [dailyNotesDataExtension],
  })
  return {h, cache, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
afterEach(() => { vi.restoreAllMocks() })

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

  // The namespace literals are pinned inside the id formula itself, in
  // src/data/derivedIds.test.ts — strictly stronger than asserting the
  // constant equals itself, since it also catches a changed key shape.
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

    const childIds = await env.repo.block(journal.id).childIds.load()
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

  /** A row at this id belonging to another workspace is never ours to touch.
   *
   *  Both reads that can find an occupant select on id alone (`repo.load` and
   *  `tx.get`), and what they feed rewrites aliases and types, resurrects
   *  tombstones, and `tx.move`s the row under THIS workspace's journal — which
   *  would pull a page out of someone else's tree.
   *
   *  One test per SITE. The guard runs at three points and each test below
   *  enters through a different one, because a single test pins them only
   *  collectively: a plain live occupant is caught by the first check and never
   *  reaches the other two. */
  describe('a row at this id belonging to another workspace', () => {
    const OTHER_WS = 'ws-someone-else'
    const foreignRow = async (deleted: boolean): Promise<string> => {
      const id = dailyNoteBlockId(WS, ISO)
      await env.repo.tx(async tx => {
        await tx.create({
          id, workspaceId: OTHER_WS, parentId: null, orderKey: 'a0',
          content: 'someone else\'s page',
        })
        if (deleted) await tx.delete(id)
      }, {scope: ChangeScope.BlockDefault})
      return id
    }

    it('is refused rather than repaired and re-parented', async () => {
      const id = await foreignRow(false)

      await expect(getOrCreateDailyNote(env.repo, WS, ISO))
        .rejects.toThrow(DeterministicIdCrossWorkspaceError)

      // Untouched: still theirs, still where it was, no alias claimed.
      const row = await env.repo.load(id)
      expect(row?.workspaceId).toBe(OTHER_WS)
      expect(row?.parentId).toBeNull()
      expect(row?.content).toBe('someone else\'s page')
      expect(row?.properties[aliasesProp.name]).toBeUndefined()
    })

    it('is refused rather than resurrected', async () => {
      // A tombstone is invisible to `repo.load`, so this enters through the
      // CREATE transaction's `tx.get` — the site that would otherwise restore
      // it, hand it this workspace's aliases, and move it under our journal.
      const id = await foreignRow(true)

      await expect(getOrCreateDailyNote(env.repo, WS, ISO))
        .rejects.toThrow(DeterministicIdCrossWorkspaceError)

      expect(await env.repo.load(id)).toBeNull()
    })

    it('is refused even when it is shaped exactly like ours, so nothing needs repair', async () => {
      // A correctly-shaped note makes `needsRepair` false, so the repair
      // transaction — and the check inside it — is never reached, and the
      // function returns the block handle directly. The check right after
      // `repo.load` is the only thing between this call and handing another
      // workspace's page back as this workspace's note for `ISO`.
      //
      // Built by creating the note properly and then relabelling the row the
      // first read returns: the shape has to survive, and only the workspace
      // may differ — which is exactly what sync materialization can produce.
      const note = await getOrCreateDailyNote(env.repo, WS, ISO)
      const shaped = {...note.peek()!, workspaceId: OTHER_WS}
      vi.spyOn(env.repo, 'load').mockResolvedValueOnce(shaped)

      await expect(getOrCreateDailyNote(env.repo, WS, ISO))
        .rejects.toThrow(DeterministicIdCrossWorkspaceError)
    })

    it('is refused when it only becomes foreign between the read and the transaction', async () => {
      // Sync materialization rewrites every stored column except `id`,
      // `workspace_id` included, so the row read before the repair transaction
      // can belong to someone else by the time it opens. Simulated by making
      // that first read disagree with what is actually on disk — which is also
      // the only way to reach the in-transaction check, since a row that is
      // already foreign is stopped one site earlier.
      const id = await foreignRow(false)
      const asIfOurs = {...(await env.repo.load(id))!, workspaceId: WS}
      vi.spyOn(env.repo, 'load').mockResolvedValueOnce(asIfOurs)

      await expect(getOrCreateDailyNote(env.repo, WS, ISO))
        .rejects.toThrow(DeterministicIdCrossWorkspaceError)

      const row = await env.repo.load(id)
      expect(row?.properties[aliasesProp.name]).toBeUndefined()
      expect(row?.parentId).toBeNull()
    })
  })
})

describe('todayDailyNoteLanding', () => {
  it('lands on today’s note, creating it if needed', async () => {
    const id = await todayDailyNoteLanding({repo: env.repo, workspaceId: WS, freshlyCreated: false})
    expect(id).toBe(dailyNoteBlockId(WS, todayIso()))
    expect(await isBlockDeleted(env.repo, id!)).toBe(false)
  })

  it('declines — without resurrecting — when today’s note is the excluded block', async () => {
    // Delete-recovery asks for a landing while the deleted page is still the
    // one the pane shows. Since the resolver is get-or-CREATE and restores
    // soft-deleted rows, answering here would silently undo the user's delete.
    const note = await getOrCreateDailyNote(env.repo, WS, todayIso())
    await env.repo.tx(tx => tx.delete(note.id), {scope: ChangeScope.BlockDefault})

    const id = await todayDailyNoteLanding({
      repo: env.repo, workspaceId: WS, freshlyCreated: false, excludeBlockId: note.id,
    })

    expect(id).toBeNull()
    expect(await isBlockDeleted(env.repo, note.id)).toBe(true)
  })

  it('still answers when the excluded block is some other page', async () => {
    const id = await todayDailyNoteLanding({
      repo: env.repo, workspaceId: WS, freshlyCreated: false, excludeBlockId: 'unrelated-page',
    })
    expect(id).toBe(dailyNoteBlockId(WS, todayIso()))
  })

  it('declines whenever today’s note is a tombstone, not just on an exact id match', async () => {
    // A pane zoomed into a CHILD of today's note recovers with the child's id,
    // so the exact-id check doesn't fire — but answering would still restore
    // the deleted parent note.
    const note = await getOrCreateDailyNote(env.repo, WS, todayIso())
    await env.repo.mutate.createChild({parentId: note.id, id: 'kid', content: 'kid'})
    await env.repo.block(note.id).delete()

    const id = await todayDailyNoteLanding({
      repo: env.repo, workspaceId: WS, freshlyCreated: false, excludeBlockId: 'kid',
    })

    expect(id).toBeNull()
    expect(await isBlockDeleted(env.repo, note.id)).toBe(true)
  })

  it('declines when the Journal itself is the tombstone', async () => {
    // getOrCreateDailyNote calls getOrCreateJournalBlock, which restores a
    // soft-deleted Journal — so recovering after a Journal delete would
    // resurrect it and hang a fresh daily note under it.
    const journal = await getOrCreateJournalBlock(env.repo, WS)
    await env.repo.block(journal.id).delete()

    const id = await todayDailyNoteLanding({
      repo: env.repo, workspaceId: WS, freshlyCreated: false, excludeBlockId: journal.id,
    })

    expect(id).toBeNull()
    expect(await isBlockDeleted(env.repo, journal.id)).toBe(true)
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

describe('undo grouping (issue #306)', () => {
  it('cold-path getOrCreateDailyNote (journal + note txs) records ONE undo entry', async () => {
    const {repo} = env
    repo.setActiveWorkspaceId(WS)
    const iso = '2026-04-28'
    const note = await getOrCreateDailyNote(repo, WS, iso)

    // Fresh workspace: journal bootstrap + note creation are separate txs, and
    // #306 is that one cmd-Z undoes opening the day — so, one entry.
    expect(repo.undoManager.depths(ChangeScope.BlockDefault)).toEqual({undo: 1, redo: 0})

    expect(await repo.undo()).toBe(true)
    expect(await isBlockDeleted(repo, note.id)).toBe(true)
    expect(await isBlockDeleted(repo, journalBlockId(WS))).toBe(true)
  })

  it('warm-path getOrCreateDailyNote (note exists, no repair) records nothing', async () => {
    const {repo} = env
    repo.setActiveWorkspaceId(WS)
    const iso = '2026-04-28'
    await getOrCreateDailyNote(repo, WS, iso)
    repo.undoManager.clear()

    await getOrCreateDailyNote(repo, WS, iso)
    expect(repo.undoManager.depths(ChangeScope.BlockDefault)).toEqual({undo: 0, redo: 0})
  })
})
