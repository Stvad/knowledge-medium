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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { aliasesProp } from '@/data/internals/coreProperties'
import { typesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import {
  DAILY_NOTE_NS,
  DAILY_NOTE_TYPE,
  dailyNoteBlockId,
  dailyNotesDataExtension,
  ensureDailyNoteTarget,
  isDateAlias,
} from '@/plugins/daily-notes'

const WS = 'ws-1'

interface Harness {
  h: TestDb
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
    registerKernelProcessors: false,
  })
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
  ]))
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

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
})
