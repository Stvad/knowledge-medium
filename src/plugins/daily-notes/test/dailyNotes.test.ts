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
import { aliasesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { dailyNoteDateProp } from '@/plugins/daily-notes/schema.ts'
import {
  backfillDailyNoteDatePropertyIfNeeded,
  DAILY_NOTE_DATE_BACKFILL_MARKER_KEY,
} from '@/plugins/daily-notes/localSchema.ts'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
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
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
  ]))
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
})

describe('backfillDailyNoteDatePropertyIfNeeded', () => {
  /** Test harness mirror of `LocalSchemaDb` over the PowerSync handle
   *  in `env.h.db`. Production `repoProvider` builds the same shim. */
  const localDb = (h: TestDb) => ({
    execute: (sql: string) => h.db.execute(sql),
    getOptional: async <T,>(sql: string): Promise<T | null> => {
      const row = await h.db.getOptional<T>(sql)
      return row ?? null
    },
  })

  /** createTestDb's template runs `applyLocalSchemaContributions` at
   *  init time, which records this backfill's marker on an empty DB.
   *  Tests that exercise the backfill itself need to clear that marker
   *  first so the gate doesn't short-circuit. */
  const resetBackfillMarker = async () => {
    await env.h.db.execute(
      'DELETE FROM client_schema_state WHERE key = ?',
      [DAILY_NOTE_DATE_BACKFILL_MARKER_KEY],
    )
  }

  /** Bypass the codec write path to simulate a legacy row: daily-note
   *  type with ISO aliases but no `dailyNoteDateProp` value. The
   *  `tx.update` raw-properties path lets us drop the new property
   *  without it being repopulated by `addTypeInTx`. */
  const seedLegacyDailyNote = async (iso: string): Promise<string> => {
    const note = await getOrCreateDailyNote(env.repo, WS, iso)
    await env.repo.tx(async tx => {
      const current = await tx.get(note.id)
      if (!current) return
      const props = {...current.properties}
      delete props[dailyNoteDateProp.name]
      await tx.update(note.id, {properties: props})
    }, {scope: ChangeScope.BlockDefault})
    return note.id
  }

  it('populates the date property from the ISO alias for legacy rows', async () => {
    const id = await seedLegacyDailyNote('2026-04-28')

    const before = await env.h.db.getAll<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?',
      [id],
    )
    const beforeParsed = JSON.parse(before[0]?.properties_json ?? '{}')
    expect(beforeParsed[dailyNoteDateProp.name]).toBeUndefined()

    await resetBackfillMarker()
    await backfillDailyNoteDatePropertyIfNeeded(localDb(env.h))

    // Backfill writes via raw UPDATE so the cached row would otherwise
    // serve the pre-backfill properties; check the DB row directly.
    const after = await env.h.db.getAll<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?',
      [id],
    )
    const afterParsed = JSON.parse(after[0]?.properties_json ?? '{}')
    expect(afterParsed[dailyNoteDateProp.name]).toBe('2026-04-28T00:00:00.000Z')
  })

  it('records the marker so subsequent calls noop', async () => {
    await seedLegacyDailyNote('2026-04-28')
    await resetBackfillMarker()
    await backfillDailyNoteDatePropertyIfNeeded(localDb(env.h))

    const marker = await env.h.db.getAll<{key: string}>(
      'SELECT key FROM client_schema_state WHERE key = ?',
      [DAILY_NOTE_DATE_BACKFILL_MARKER_KEY],
    )
    expect(marker).toHaveLength(1)

    // Drop the property again post-marker; the second invocation must
    // not re-populate (one-shot semantic).
    const id = dailyNoteBlockId(WS, '2026-04-28')
    await env.repo.tx(async tx => {
      const current = await tx.get(id)
      if (!current) return
      const props = {...current.properties}
      delete props[dailyNoteDateProp.name]
      await tx.update(id, {properties: props})
    }, {scope: ChangeScope.BlockDefault})

    await backfillDailyNoteDatePropertyIfNeeded(localDb(env.h))
    const reloadedRow = await env.h.db.getAll<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?',
      [id],
    )
    const reloadedProps = JSON.parse(reloadedRow[0]?.properties_json ?? '{}')
    expect(reloadedProps[dailyNoteDateProp.name]).toBeUndefined()
  })

  it('noops on an empty workspace and still records the marker', async () => {
    await resetBackfillMarker()
    await backfillDailyNoteDatePropertyIfNeeded(localDb(env.h))
    const marker = await env.h.db.getAll<{key: string}>(
      'SELECT key FROM client_schema_state WHERE key = ?',
      [DAILY_NOTE_DATE_BACKFILL_MARKER_KEY],
    )
    expect(marker).toHaveLength(1)
  })
})
