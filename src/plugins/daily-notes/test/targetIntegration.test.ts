// @vitest-environment node
/**
 * Tests for the daily-notes target-integration surface — the helpers
 * the backlinks references-processor calls to route date-shaped
 * aliases. Migrated from `src/data/targets.test.ts` when the daily-
 * notes plugin took ownership of these helpers.
 *
 * Coverage:
 *   - dailyNoteBlockId: stable per (workspaceId, iso); namespace
 *     pinned to the documented DAILY_NOTE_NS constant
 *   - isDateAlias: matches strict YYYY-MM-DD, rejects close-but-no
 *   - ensureDailyNoteTarget: inserts daily-note row with the
 *     deterministic id + iso alias + DAILY_NOTE_TYPE on the row's
 *     typesProp; shares its namespace with `dailyNoteBlockId`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { aliasesProp, typesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import {
  DAILY_NOTE_NS,
  DAILY_NOTE_TYPE,
  dailyNoteBlockId,
  dailyNotesDataExtension,
  ensureDailyNoteTarget,
  isDateAlias,
  isValidDateAlias,
} from '@/plugins/daily-notes'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
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
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
// Dispose the per-test Repo's sync observer so its db.onChange subscription
// doesn't leak onto the shared DB (closed once in afterAll).
afterEach(() => { env.repo.stopSyncObserver() })

describe('dailyNoteBlockId', () => {
  it('is stable for a given (workspaceId, iso)', () => {
    expect(dailyNoteBlockId(WS, '2026-04-28'))
      .toBe(dailyNoteBlockId(WS, '2026-04-28'))
  })

  it('differs across workspaces for the same iso', () => {
    expect(dailyNoteBlockId('ws-a', '2026-04-28'))
      .not.toBe(dailyNoteBlockId('ws-b', '2026-04-28'))
  })

  it('uses the documented daily-note namespace constant', () => {
    expect(DAILY_NOTE_NS).toBe('53421e08-2f31-42f8-b73a-43830bb718f1')
  })
})

describe('isDateAlias', () => {
  it('matches strict YYYY-MM-DD', () => {
    expect(isDateAlias('2026-04-28')).toBe(true)
    expect(isDateAlias('1999-12-31')).toBe(true)
  })

  it('rejects close-but-no shapes', () => {
    expect(isDateAlias('2026-4-28')).toBe(false)   // missing zero pad
    expect(isDateAlias('26-04-28')).toBe(false)    // 2-digit year
    expect(isDateAlias('2026/04/28')).toBe(false)  // wrong separator
    expect(isDateAlias('2026-04-28T00:00:00Z')).toBe(false)  // trailing
    expect(isDateAlias('hello')).toBe(false)
    expect(isDateAlias('')).toBe(false)
  })

  it('is shape-only — accepts calendar-invalid YYYY-MM-DD', () => {
    // Distinct from `isValidDateAlias`. Documented here so a future
    // change that tightens `isDateAlias` itself triggers a test
    // failure and the author has to reconcile the SRS find/extract
    // call sites that depend on the shape-only contract.
    expect(isDateAlias('2026-13-01')).toBe(true)
    expect(isDateAlias('2026-02-30')).toBe(true)
  })
})

describe('isValidDateAlias', () => {
  it('matches real calendar days', () => {
    expect(isValidDateAlias('2026-04-28')).toBe(true)
    expect(isValidDateAlias('2024-02-29')).toBe(true)  // leap day
    expect(isValidDateAlias('1999-12-31')).toBe(true)
  })

  it('rejects calendar-invalid shapes that `isDateAlias` accepts', () => {
    expect(isValidDateAlias('2026-13-01')).toBe(false)  // month 13
    expect(isValidDateAlias('2026-02-30')).toBe(false)  // Feb 30 → Mar 2
    expect(isValidDateAlias('2025-02-29')).toBe(false)  // non-leap
    expect(isValidDateAlias('2026-04-31')).toBe(false)  // Apr 31 → May 1
  })

  it('rejects non-date shapes', () => {
    expect(isValidDateAlias('2026-4-28')).toBe(false)
    expect(isValidDateAlias('hello')).toBe(false)
    expect(isValidDateAlias('')).toBe(false)
  })
})

describe('ensureDailyNoteTarget', () => {
  it('inserts a daily-note row with the deterministic id + iso alias', async () => {
    const ISO = '2026-04-28'
    const typeSnapshot = env.repo.snapshotTypeRegistries()
    const result = await env.repo.tx(tx => ensureDailyNoteTarget(tx, env.repo, ISO, WS, typeSnapshot),
      {scope: ChangeScope.BlockDefault})

    expect(result.id).toBe(dailyNoteBlockId(WS, ISO))
    expect(result.inserted).toBe(true)

    const row = await env.h.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [result.id])
    const props = JSON.parse(row.properties_json)
    expect(props[aliasesProp.name]).toEqual([ISO])
    expect(props[typesProp.name]).toEqual([PAGE_TYPE, DAILY_NOTE_TYPE])
  })

  it('defaults the inserted seat\'s content to the iso alias', async () => {
    // Mirrors the ensureAliasTarget creation-time-default rule: a freshly
    // materialised daily-note seat shouldn't be born content-drifted from
    // its alias. getOrCreateDailyNote promotes the seat later with the
    // long-form label; until then the iso is the right default.
    const ISO = '2026-04-28'
    const typeSnapshot = env.repo.snapshotTypeRegistries()
    const result = await env.repo.tx(tx => ensureDailyNoteTarget(tx, env.repo, ISO, WS, typeSnapshot),
      {scope: ChangeScope.BlockDefault})

    const row = await env.h.db.get<{content: string}>(
      'SELECT content FROM blocks WHERE id = ?', [result.id])
    expect(row.content).toBe(ISO)
  })

  it('is idempotent: second call on the same (ws, iso) returns inserted=false', async () => {
    const ISO = '2026-04-28'
    const typeSnapshot = env.repo.snapshotTypeRegistries()
    const first = await env.repo.tx(tx => ensureDailyNoteTarget(tx, env.repo, ISO, WS, typeSnapshot),
      {scope: ChangeScope.BlockDefault})
    const second = await env.repo.tx(tx => ensureDailyNoteTarget(tx, env.repo, ISO, WS, typeSnapshot),
      {scope: ChangeScope.BlockDefault})

    expect(first.id).toBe(second.id)
    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
  })

  it('rejects calendar-invalid date-shaped inputs (contract enforced by routing)', async () => {
    // The references processor's `isValidDateAlias` gate is the
    // canonical filter; calendar-invalid strings never reach
    // `ensureDailyNoteTarget` in production. Direct callers that
    // bypass that gate get a clear failure rather than silently
    // creating a daily-note seat for a nonexistent calendar day.
    const typeSnapshot = env.repo.snapshotTypeRegistries()
    for (const bogusIso of ['2026-13-01', '2026-02-30']) {
      await expect(
        env.repo.tx(
          tx => ensureDailyNoteTarget(tx, env.repo, bogusIso, WS, typeSnapshot),
          {scope: ChangeScope.BlockDefault},
        ),
      ).rejects.toThrow(/Invalid (?:ISO|calendar) date for daily note/)
    }
  })
})
