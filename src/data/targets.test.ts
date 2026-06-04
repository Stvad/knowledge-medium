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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ChangeScope,
  DeterministicIdCrossWorkspaceError,
} from '@/data/api'
import { aliasesProp } from '@/data/internals/coreProperties'
import { typesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from './repo'
import {
  aliasSeatSeed,
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
    registerKernelProcessors: false,
  })
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
afterEach(() => { env.repo.stopSyncObserver() })

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

  it('restores a pristine tombstone in place (transient-cleanup tombstones are reusable)', async () => {
    // ensureAliasTarget creates slot 0 as a clean seed (content === alias,
    // properties === {alias:[foo], types:['page']}, no children). Cleanup
    // tombstones it. Re-typing [[foo]] should reuse slot 0 — the
    // tombstone's only signal is "no one referenced this transient seat
    // in time"; bringing it back at the same id keeps the deterministic-
    // id slot space compact instead of probing deeper on every retype.
    const slot0Id = computeAliasSeatId('foo', WS, 0)
    const typeSnapshot = env.repo.snapshotTypeRegistries()
    await env.repo.tx(tx => ensureAliasTarget(tx, env.repo, 'foo', WS, typeSnapshot),
      {scope: ChangeScope.BlockDefault})
    await env.repo.tx(tx => tx.delete(slot0Id), {scope: ChangeScope.BlockDefault})

    const result = await env.repo.tx(async tx => {
      return ensureAliasTarget(tx, env.repo, 'foo', WS, typeSnapshot)
    }, {scope: ChangeScope.BlockDefault})

    expect(result.id).toBe(slot0Id)
    expect(result.inserted).toBe(true)
    const slot0Row = await env.h.db.get<{deleted: 0 | 1, content: string}>(
      'SELECT deleted, content FROM blocks WHERE id = ?', [slot0Id])
    expect(slot0Row.deleted).toBe(0)
    expect(slot0Row.content).toBe('foo')
  })

  it('probes past a tombstone whose content drifted from the alias (user renamed it)', async () => {
    // Pre-rename signal: content differs from alias[0]. We can't tell
    // whether the user explicitly deleted a real page or whether cleanup
    // tombstoned a renamed-then-orphaned seat; either way restoring would
    // resurrect the rename, so keep slot 0 dead and probe to slot 1.
    const slot0Id = computeAliasSeatId('foo', WS, 0)
    const slot1Id = computeAliasSeatId('foo', WS, 1)
    const typeSnapshot = env.repo.snapshotTypeRegistries()
    await env.repo.tx(tx => ensureAliasTarget(tx, env.repo, 'foo', WS, typeSnapshot),
      {scope: ChangeScope.BlockDefault})
    await env.repo.tx(tx => tx.update(slot0Id, {content: 'renamed'}),
      {scope: ChangeScope.BlockDefault})
    await env.repo.tx(tx => tx.delete(slot0Id), {scope: ChangeScope.BlockDefault})

    const result = await env.repo.tx(async tx => {
      return ensureAliasTarget(tx, env.repo, 'foo', WS, typeSnapshot)
    }, {scope: ChangeScope.BlockDefault})

    expect(result.id).toBe(slot1Id)
    expect(result.inserted).toBe(true)
    const slot0Row = await env.h.db.get<{deleted: 0 | 1}>(
      'SELECT deleted FROM blocks WHERE id = ?', [slot0Id])
    expect(slot0Row.deleted).toBe(1)
  })

  it('probes past a tombstone with extra user-added properties', async () => {
    // The seed shape is {alias:[X], types:['page']}. Anything beyond
    // that is a user touch (a tag, a custom prop, etc.) and means the
    // page wasn't "purely transient" — restoring would resurrect those
    // edits.
    const slot0Id = computeAliasSeatId('foo', WS, 0)
    const slot1Id = computeAliasSeatId('foo', WS, 1)
    const typeSnapshot = env.repo.snapshotTypeRegistries()
    await env.repo.tx(tx => ensureAliasTarget(tx, env.repo, 'foo', WS, typeSnapshot),
      {scope: ChangeScope.BlockDefault})
    await env.repo.tx(async tx => {
      const block = await tx.get(slot0Id)
      await tx.update(slot0Id, {
        properties: {...block!.properties, 'user-tag': 'important'},
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.tx(tx => tx.delete(slot0Id), {scope: ChangeScope.BlockDefault})

    const result = await env.repo.tx(async tx => {
      return ensureAliasTarget(tx, env.repo, 'foo', WS, typeSnapshot)
    }, {scope: ChangeScope.BlockDefault})

    expect(result.id).toBe(slot1Id)
    expect(result.inserted).toBe(true)
  })

  it('probes past a tombstone that still has live children', async () => {
    // A user could open the auto-created page and add child blocks
    // before cleanup fires (or before they delete the page manually).
    // Soft-delete doesn't cascade today, so a tombstoned seat with
    // live kids is "user touched"; restoring it would expose the kids
    // back under a now-live parent unannounced.
    const slot0Id = computeAliasSeatId('foo', WS, 0)
    const slot1Id = computeAliasSeatId('foo', WS, 1)
    const typeSnapshot = env.repo.snapshotTypeRegistries()
    await env.repo.tx(tx => ensureAliasTarget(tx, env.repo, 'foo', WS, typeSnapshot),
      {scope: ChangeScope.BlockDefault})
    await env.repo.tx(tx => tx.create({
      id: 'child-1',
      workspaceId: WS,
      parentId: slot0Id,
      orderKey: 'a0',
      content: 'child content',
    }), {scope: ChangeScope.BlockDefault})
    await env.repo.tx(tx => tx.delete(slot0Id), {scope: ChangeScope.BlockDefault})

    const result = await env.repo.tx(async tx => {
      return ensureAliasTarget(tx, env.repo, 'foo', WS, typeSnapshot)
    }, {scope: ChangeScope.BlockDefault})

    expect(result.id).toBe(slot1Id)
    expect(result.inserted).toBe(true)
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

describe('ensureAliasTarget — seed-shape contract', () => {
  it('writes a row whose (content, properties) matches aliasSeatSeed exactly', async () => {
    // Drift detector. The probe's restorability predicate compares
    // tombstoned rows against `aliasSeatSeed(alias)`; if a future change
    // to ensureAliasTarget (or to addTypeInTx's PAGE_TYPE handling) ever
    // produces a row that doesn't equal the seed, the predicate would
    // silently fail to restore fresh tombstones too. Asserting the
    // post-write shape here forces seed-builder + writer to stay
    // in lockstep — fix one place when the contract changes.
    const typeSnapshot = env.repo.snapshotTypeRegistries()
    const result = await env.repo.tx(
      tx => ensureAliasTarget(tx, env.repo, 'Foo', WS, typeSnapshot),
      {scope: ChangeScope.BlockDefault},
    )
    const row = await env.h.db.get<{content: string; properties_json: string}>(
      'SELECT content, properties_json FROM blocks WHERE id = ?', [result.id])
    const seed = aliasSeatSeed('Foo')
    expect(row.content).toBe(seed.content)
    expect(JSON.parse(row.properties_json)).toEqual(seed.properties)
  })
})

