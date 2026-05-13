// @vitest-environment node
/**
 * Tests for `targets.ts` — the shared deterministic-id helpers + the
 * createOrRestore primitive used by parseReferences (kernel) and the
 * Roam importer.
 *
 * Coverage:
 *   - computeAliasSeatId: stable per (workspaceId, alias); workspace-
 *     scoped (same alias in different workspaces → different ids)
 *   - createOrRestoreTargetBlock: insert path → inserted=true,
 *     onInsertedOrRestored fires
 *   - createOrRestoreTargetBlock: live-row hit → inserted=false,
 *     onInsertedOrRestored does NOT fire
 *   - createOrRestoreTargetBlock: tombstone → restored, freshContent
 *     applied via tx.restore, onInsertedOrRestored fires, inserted=true
 *   - ensureAliasTarget: id derives from ALIAS_NS, sets aliases=[alias]
 *     on insert, idempotent across calls in same workspace
 *   - DeterministicIdCrossWorkspaceError surfaces (not swallowed)
 *
 * Daily-note-specific coverage (computeDailyNoteId, isDateAlias,
 * ensureDailyNoteTarget) lives in `src/plugins/daily-notes/test/`
 * since the daily-notes plugin owns those helpers now.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ChangeScope,
  DeterministicIdCrossWorkspaceError,
} from '@/data/api'
import { aliasesProp } from '@/data/internals/coreProperties'
import { typesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from './repo'
import {
  computeAliasSeatId,
  createOrRestoreTargetBlock,
  ensureAliasTarget,
} from '@/data/targets'

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

describe('computeAliasSeatId', () => {
  it('is stable for a given (workspaceId, alias)', () => {
    expect(computeAliasSeatId('foo', WS)).toBe(computeAliasSeatId('foo', WS))
  })

  it('differs across workspaces for the same alias', () => {
    expect(computeAliasSeatId('foo', 'ws-a'))
      .not.toBe(computeAliasSeatId('foo', 'ws-b'))
  })

  it('differs across aliases in the same workspace', () => {
    expect(computeAliasSeatId('foo', WS))
      .not.toBe(computeAliasSeatId('bar', WS))
  })
})

describe('createOrRestoreTargetBlock — insert path', () => {
  it('inserts a fresh row, returns {inserted: true}, fires callback', async () => {
    const callbackCalls: string[] = []
    const id = computeAliasSeatId('fresh', WS)

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
    const id = computeAliasSeatId('live', WS)

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
    const id = computeAliasSeatId('tombstone', WS)

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
    const id = computeAliasSeatId('shared', 'ws-a')

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
    const typeSnapshot = env.repo.snapshotTypeRegistries()
    const result = await env.repo.tx(async tx => {
      return ensureAliasTarget(tx, env.repo, 'foo', WS, typeSnapshot)
    }, {scope: ChangeScope.BlockDefault})

    expect(result.id).toBe(computeAliasSeatId('foo', WS))
    expect(result.inserted).toBe(true)

    const row = await env.h.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [result.id])
    const props = JSON.parse(row.properties_json)
    expect(props[aliasesProp.name]).toEqual(['foo'])
    expect(props[typesProp.name]).toEqual([PAGE_TYPE])
  })

  it('defaults the inserted row\'s content to the alias text', async () => {
    // Otherwise a [[Foo]] link-resolution materialises a page whose
    // displayed title is empty until the next content edit triggers
    // A3 drift-heal. Steady-state alias≠content (post-rename) is still
    // allowed; this is just the creation-time default.
    const typeSnapshot = env.repo.snapshotTypeRegistries()
    const result = await env.repo.tx(tx => ensureAliasTarget(tx, env.repo, 'Foo', WS, typeSnapshot),
      {scope: ChangeScope.BlockDefault})

    const row = await env.h.db.get<{content: string}>(
      'SELECT content FROM blocks WHERE id = ?', [result.id])
    expect(row.content).toBe('Foo')
  })

  it('is idempotent: second call returns inserted=false on the same row', async () => {
    const typeSnapshot = env.repo.snapshotTypeRegistries()
    const a = await env.repo.tx(tx => ensureAliasTarget(tx, env.repo, 'foo', WS, typeSnapshot),
      {scope: ChangeScope.BlockDefault})
    const b = await env.repo.tx(tx => ensureAliasTarget(tx, env.repo, 'foo', WS, typeSnapshot),
      {scope: ChangeScope.BlockDefault})

    expect(a.id).toBe(b.id)
    expect(a.inserted).toBe(true)
    expect(b.inserted).toBe(false)
  })
})

describe('ensureAliasTarget — indexed-deterministic seat probe', () => {
  it('probes past a live row claiming a different alias (post-rename collision)', async () => {
    // Pre-seed slot 0 with a row that claims a DIFFERENT alias —
    // simulates the post-rename state where the user renamed `foo`
    // to `bar`, leaving slot 0 holding `bar`. A subsequent type of
    // [[foo]] should walk to slot 1, not silently re-resolve to the
    // renamed `bar` row.
    const slot0Id = computeAliasSeatId('foo', WS, 0)
    const slot1Id = computeAliasSeatId('foo', WS, 1)
    const typeSnapshot = env.repo.snapshotTypeRegistries()
    await env.repo.tx(async tx => {
      await tx.create({
        id: slot0Id,
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: '',
      })
      await tx.setProperty(slot0Id, aliasesProp, ['bar'])
    }, {scope: ChangeScope.BlockDefault})

    const result = await env.repo.tx(async tx => {
      return ensureAliasTarget(tx, env.repo, 'foo', WS, typeSnapshot)
    }, {scope: ChangeScope.BlockDefault})

    expect(result.id).toBe(slot1Id)
    expect(result.inserted).toBe(true)
    // Slot 0 untouched (still holds bar).
    const slot0Row = await env.h.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [slot0Id])
    expect(JSON.parse(slot0Row.properties_json)[aliasesProp.name]).toEqual(['bar'])
    // Slot 1 now holds foo.
    const slot1Row = await env.h.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [slot1Id])
    expect(JSON.parse(slot1Row.properties_json)[aliasesProp.name]).toEqual(['foo'])
  })

  it('probes past a tombstone (deleted seat does not get restored on retype)', async () => {
    // Cycle 1: insert at slot 0, then soft-delete it. Spec says
    // "tombstone-restore-on-retype goes away" — re-typing [[foo]]
    // should land at slot 1 as a FRESH seat, not bring slot 0 back.
    const slot0Id = computeAliasSeatId('foo', WS, 0)
    const slot1Id = computeAliasSeatId('foo', WS, 1)
    const typeSnapshot = env.repo.snapshotTypeRegistries()
    await env.repo.tx(tx => ensureAliasTarget(tx, env.repo, 'foo', WS, typeSnapshot),
      {scope: ChangeScope.BlockDefault})
    await env.repo.tx(tx => tx.delete(slot0Id), {scope: ChangeScope.BlockDefault})

    const result = await env.repo.tx(async tx => {
      return ensureAliasTarget(tx, env.repo, 'foo', WS, typeSnapshot)
    }, {scope: ChangeScope.BlockDefault})

    expect(result.id).toBe(slot1Id)
    expect(result.inserted).toBe(true)
    // Slot 0 stays tombstoned.
    const slot0Row = await env.h.db.get<{deleted: 0 | 1}>(
      'SELECT deleted FROM blocks WHERE id = ?', [slot0Id])
    expect(slot0Row.deleted).toBe(1)
  })

  it('reuses slot 0 when a live row already claims this alias', async () => {
    // Convergence happy path: typing [[foo]], cleanup wipes the seat,
    // user re-types [[foo]] — no wait, that's the tombstone case
    // above. Here we test the offline-convergence path: an alias seat
    // already exists at slot 0 claiming the alias (created by a sync
    // peer), and a fresh ensureAliasTarget should reuse it rather
    // than probing past.
    const slot0Id = computeAliasSeatId('foo', WS, 0)
    await env.repo.tx(async tx => {
      await tx.create({
        id: slot0Id,
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: '',
      })
      await tx.setProperty(slot0Id, aliasesProp, ['foo'])
    }, {scope: ChangeScope.BlockDefault})

    const typeSnapshot = env.repo.snapshotTypeRegistries()
    const result = await env.repo.tx(async tx => {
      return ensureAliasTarget(tx, env.repo, 'foo', WS, typeSnapshot)
    }, {scope: ChangeScope.BlockDefault})

    expect(result.id).toBe(slot0Id)
    expect(result.inserted).toBe(false)
  })
})

