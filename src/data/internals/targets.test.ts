// @vitest-environment node
/**
 * Tests for `targets.ts` — the shared deterministic-id helpers + the
 * createOrRestore primitive used by parseReferences (kernel) and the
 * Roam importer.
 *
 * Coverage:
 *   - computeAliasTargetId: stable per (workspaceId, alias); workspace-
 *     scoped (same alias in different workspaces → different ids)
 *   - computeDailyNoteId: stable per (workspaceId, iso); namespace
 *     matches dailyNotes.DAILY_NOTE_NS (server migration parity)
 *   - isDateAlias: matches strict YYYY-MM-DD shape, rejects close-but-no
 *   - createOrRestoreTargetBlock: insert path → inserted=true,
 *     onInsertedOrRestored fires
 *   - createOrRestoreTargetBlock: live-row hit → inserted=false,
 *     onInsertedOrRestored does NOT fire
 *   - createOrRestoreTargetBlock: tombstone → restored, freshContent
 *     applied via tx.restore, onInsertedOrRestored fires, inserted=true
 *   - ensureAliasTarget: id derives from ALIAS_NS, sets aliases=[alias]
 *     on insert, idempotent across calls in same workspace
 *   - ensureDailyNoteTarget: id matches DAILY_NOTE_NS computation,
 *     sets aliases=[date]
 *   - DeterministicIdCrossWorkspaceError surfaces (not swallowed)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ChangeScope,
  DeterministicIdCrossWorkspaceError,
} from '@/data/api'
import { aliasesProp } from '@/data/internals/coreProperties'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/internals/repo'
import {
  computeAliasTargetId,
  computeDailyNoteId,
  createOrRestoreTargetBlock,
  ensureAliasTarget,
  ensureDailyNoteTarget,
  isDateAlias,
} from '@/data/internals/targets'
import { dailyNoteBlockId, DAILY_NOTE_NS } from '@/data/dailyNotes'

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
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

describe('computeAliasTargetId', () => {
  it('is stable for a given (workspaceId, alias)', () => {
    expect(computeAliasTargetId('foo', WS)).toBe(computeAliasTargetId('foo', WS))
  })

  it('differs across workspaces for the same alias', () => {
    expect(computeAliasTargetId('foo', 'ws-a'))
      .not.toBe(computeAliasTargetId('foo', 'ws-b'))
  })

  it('differs across aliases in the same workspace', () => {
    expect(computeAliasTargetId('foo', WS))
      .not.toBe(computeAliasTargetId('bar', WS))
  })
})

describe('computeDailyNoteId', () => {
  it('is stable for a given (workspaceId, iso)', () => {
    expect(computeDailyNoteId('2026-04-28', WS))
      .toBe(computeDailyNoteId('2026-04-28', WS))
  })

  it('matches dailyNotes.dailyNoteBlockId — same namespace + input shape', () => {
    // The two helpers must agree so parseReferences's daily-note
    // routing produces the same row as `getOrCreateDailyNote`.
    expect(computeDailyNoteId('2026-04-28', WS))
      .toBe(dailyNoteBlockId(WS, '2026-04-28'))
  })

  it('uses the documented daily-note namespace constant', () => {
    // Pinned reference: the supabase migration computes the same value
    // server-side via uuid_generate_v5. Drift on either side
    // reintroduces the duplicate-page bug.
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

describe('createOrRestoreTargetBlock — insert path', () => {
  it('inserts a fresh row, returns {inserted: true}, fires callback', async () => {
    const callbackCalls: string[] = []
    const id = computeAliasTargetId('fresh', WS)

    const result = await env.repo.tx(async tx => {
      return createOrRestoreTargetBlock(tx, {
        id,
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        freshContent: 'fresh content',
        onInsertedOrRestored: async (_tx, calledId) => {
          callbackCalls.push(calledId)
        },
      })
    }, {scope: ChangeScope.BlockDefault})

    expect(result).toEqual({id, inserted: true})
    expect(callbackCalls).toEqual([id])

    const row = await env.h.db.get<{id: string, content: string}>(
      'SELECT id, content FROM blocks WHERE id = ?', [id])
    expect(row.content).toBe('fresh content')
  })
})

describe('createOrRestoreTargetBlock — live-row hit', () => {
  it('returns {inserted: false} and does NOT fire callback', async () => {
    const id = computeAliasTargetId('live', WS)

    // Pre-create the row.
    await env.repo.tx(tx => tx.create({
      id,
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      content: 'pre-existing',
    }), {scope: ChangeScope.BlockDefault})

    const callbackCalls: string[] = []
    const result = await env.repo.tx(async tx => {
      return createOrRestoreTargetBlock(tx, {
        id,
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        freshContent: 'IGNORED on live-row hit',
        onInsertedOrRestored: async (_tx, calledId) => {
          callbackCalls.push(calledId)
        },
      })
    }, {scope: ChangeScope.BlockDefault})

    expect(result).toEqual({id, inserted: false})
    expect(callbackCalls).toEqual([])

    // Content not refreshed on live-row hit.
    const row = await env.h.db.get<{content: string}>(
      'SELECT content FROM blocks WHERE id = ?', [id])
    expect(row.content).toBe('pre-existing')
  })
})

describe('createOrRestoreTargetBlock — tombstone path', () => {
  it('restores tombstoned row, applies freshContent, fires callback, returns inserted=true', async () => {
    const id = computeAliasTargetId('tombstone', WS)

    // Pre-create + soft-delete the row.
    await env.repo.tx(tx => tx.create({
      id,
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      content: 'old content',
    }), {scope: ChangeScope.BlockDefault})
    await env.repo.tx(tx => tx.delete(id), {scope: ChangeScope.BlockDefault})

    const callbackCalls: string[] = []
    const result = await env.repo.tx(async tx => {
      return createOrRestoreTargetBlock(tx, {
        id,
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        freshContent: 'restored content',
        onInsertedOrRestored: async (_tx, calledId) => {
          callbackCalls.push(calledId)
        },
      })
    }, {scope: ChangeScope.BlockDefault})

    expect(result).toEqual({id, inserted: true})
    expect(callbackCalls).toEqual([id])

    const row = await env.h.db.get<{content: string, deleted: 0|1}>(
      'SELECT content, deleted FROM blocks WHERE id = ?', [id])
    expect(row.deleted).toBe(0)
    expect(row.content).toBe('restored content')
  })
})

describe('createOrRestoreTargetBlock — workspace mismatch', () => {
  it('surfaces DeterministicIdCrossWorkspaceError (does not swallow)', async () => {
    const id = computeAliasTargetId('shared', 'ws-a')

    // Pre-seed in ws-a.
    await env.repo.tx(tx => tx.create({
      id,
      workspaceId: 'ws-a',
      parentId: null,
      orderKey: 'a0',
      content: '',
    }), {scope: ChangeScope.BlockDefault})

    // Same id, different workspace → engine throws on createOrGet.
    await expect(env.repo.tx(async tx => {
      return createOrRestoreTargetBlock(tx, {
        id,
        workspaceId: 'ws-b',
        parentId: null,
        orderKey: 'a0',
        freshContent: '',
      })
    }, {scope: ChangeScope.BlockDefault}))
      .rejects.toBeInstanceOf(DeterministicIdCrossWorkspaceError)
  })
})

describe('ensureAliasTarget', () => {
  it('inserts an alias-target row with the correct deterministic id + alias property', async () => {
    const result = await env.repo.tx(async tx => {
      return ensureAliasTarget(tx, 'foo', WS)
    }, {scope: ChangeScope.BlockDefault})

    expect(result.id).toBe(computeAliasTargetId('foo', WS))
    expect(result.inserted).toBe(true)

    const row = await env.h.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [result.id])
    expect(JSON.parse(row.properties_json)[aliasesProp.name]).toEqual(['foo'])
  })

  it('is idempotent: second call returns inserted=false on the same row', async () => {
    const a = await env.repo.tx(tx => ensureAliasTarget(tx, 'foo', WS),
      {scope: ChangeScope.BlockDefault})
    const b = await env.repo.tx(tx => ensureAliasTarget(tx, 'foo', WS),
      {scope: ChangeScope.BlockDefault})

    expect(a.id).toBe(b.id)
    expect(a.inserted).toBe(true)
    expect(b.inserted).toBe(false)
  })
})

describe('ensureDailyNoteTarget', () => {
  it('inserts a daily-note row with the daily-note deterministic id + iso alias', async () => {
    const ISO = '2026-04-28'
    const result = await env.repo.tx(tx => ensureDailyNoteTarget(tx, ISO, WS),
      {scope: ChangeScope.BlockDefault})

    expect(result.id).toBe(computeDailyNoteId(ISO, WS))
    expect(result.inserted).toBe(true)

    const row = await env.h.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [result.id])
    expect(JSON.parse(row.properties_json)[aliasesProp.name]).toEqual([ISO])
  })

  it('shares the namespace with dailyNotes.dailyNoteBlockId', async () => {
    const ISO = '2026-04-28'
    const result = await env.repo.tx(tx => ensureDailyNoteTarget(tx, ISO, WS),
      {scope: ChangeScope.BlockDefault})
    expect(result.id).toBe(dailyNoteBlockId(WS, ISO))
  })
})
