// @vitest-environment node
/**
 * Alias collision rejection — exercises the same-tx alias.sync
 * processor's collision-detection path. When a block tries to claim
 * an alias already held by a different live block, the processor
 * throws `ProcessorRejection`. SQLite rolls back the whole user tx
 * atomically: no rows commit, no undo entry, no stuck state.
 *
 * Covers:
 *   - A1-style collision (content edit adds new alias claim)
 *   - AR1-style collision (user writes aliases directly)
 *   - Direct-claim collision (user adds an alias via setProperty
 *     without changing content — same-tx detects regardless of
 *     which side the user touched)
 *   - Self-reclaim is not a collision (block re-asserts its own
 *     existing alias)
 *   - User-error listener fires with the rejection so the toast
 *     layer can surface it
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, ProcessorRejection } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/internals/coreProperties'
import { dailyNotesDataExtension } from '@/plugins/daily-notes'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import { referencesDataExtension } from '@/plugins/references/dataExtension.js'
import { computeAliasSeatId } from '@/data/targets'
import { aliasDataExtension } from '../dataExtension.ts'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  repo: Repo
  read(id: string): Promise<{id: string; content: string; deleted: 0 | 1; properties_json: string} | null>
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
    registerKernelProcessors: false,
  })
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
    referencesDataExtension,
    aliasDataExtension,
  ]))
  return {
    h,
    repo,
    read: async id => h.db.getOptional(
      `SELECT id, content, deleted, properties_json FROM blocks WHERE id = ?`,
      [id],
    ),
  }
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  env = await setup()
  vi.useFakeTimers({shouldAdvanceTime: true})
})
afterEach(async () => {
  vi.useRealTimers()
  env.repo.stopSyncObserver()
})

const readAliases = async (id: string): Promise<string[]> => {
  const row = await env.read(id)
  if (row === null) return []
  return (JSON.parse(row.properties_json).alias ?? []) as string[]
}

const flush = async () => {
  await vi.advanceTimersByTimeAsync(1)
  await env.repo.awaitProcessors()
}

/** Create a block claiming `alias`. Uses computeAliasSeatId for the
 *  id — the typical convergent path. Co-exists with `seatAtExplicitId`
 *  below which exercises the alternative-id path the collision
 *  check has to cover too. */
const seatAt = async (alias: string, content: string): Promise<string> => {
  const id = computeAliasSeatId(alias, WS, 0)
  await env.repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content})
    await tx.setProperty(id, aliasesProp, [alias])
  }, {scope: ChangeScope.BlockDefault})
  await flush()
  return id
}

/** Create a block claiming `alias` at an arbitrary (non-seat) id —
 *  e.g. a block originally created with content unrelated to its
 *  current alias. The trigger-maintained `block_aliases` index
 *  picks it up regardless. */
const seatAtExplicitId = async (
  id: string,
  alias: string,
  content: string,
): Promise<void> => {
  await env.repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content})
    await tx.setProperty(id, aliasesProp, [alias])
  }, {scope: ChangeScope.BlockDefault})
  await flush()
}

describe('alias.collision — A1-style (content edit adds new claim)', () => {
  it('rejects when another live block already claims the alias', async () => {
    await seatAt('Existing', 'Existing')

    // Second block, no aliases yet; user retypes its content to the
    // taken name, expecting alias sync to add `Existing` to its alias
    // list. Sync detects the collision and throws.
    await env.repo.tx(async tx => {
      await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'mine'})
      await tx.setProperty('b', aliasesProp, ['mine'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    let caught: unknown
    try {
      await env.repo.mutate.setContent({id: 'b', content: 'Existing'})
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).code).toBe('alias.collision')
    expect((caught as ProcessorRejection).meta?.alias).toBe('Existing')
    expect((caught as ProcessorRejection).meta?.dropSourceAliases).toEqual(['mine'])
    expect((caught as ProcessorRejection).meta?.collisionOrigin).toBe('content-rename')

    // Block b is unchanged — content stayed "mine", aliases stayed ["mine"].
    expect((await env.read('b'))!.content).toBe('mine')
    expect(await readAliases('b')).toEqual(['mine'])
  })
})

describe('alias.collision — AR1-style (alias swap to a taken name)', () => {
  it('rejects when user renames their alias to one held by another block', async () => {
    await seatAt('Foo', 'Foo')

    await env.repo.tx(async tx => {
      await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Bar'})
      await tx.setProperty('b', aliasesProp, ['Bar'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    let caught: unknown
    try {
      // User renames b's alias from [Bar] to [Foo] — content is
      // "Bar", removed=["Bar"], added=["Foo"]. AR1 sync plan would
      // rewrite content to "Foo" AND newly claim "Foo".
      await env.repo.tx(
        tx => tx.setProperty('b', aliasesProp, ['Foo']),
        {scope: ChangeScope.BlockDefault},
      )
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).code).toBe('alias.collision')

    // b stayed at content "Bar", aliases ["Bar"].
    expect((await env.read('b'))!.content).toBe('Bar')
    expect(await readAliases('b')).toEqual(['Bar'])
  })
})

describe('alias.collision — direct claim (no content change)', () => {
  it('rejects when user adds a taken alias via setProperty', async () => {
    await seatAt('Shared', 'Shared')

    await env.repo.tx(async tx => {
      await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'distinct'})
      await tx.setProperty('b', aliasesProp, ['distinct'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    let caught: unknown
    try {
      // Adds 'Shared' alongside the existing 'distinct' — not a
      // 1-for-1 swap, not a content edit, but still claims a taken
      // name. The "directly claimed" branch of planSync catches this.
      await env.repo.tx(
        tx => tx.setProperty('b', aliasesProp, ['distinct', 'Shared']),
        {scope: ChangeScope.BlockDefault},
      )
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).code).toBe('alias.collision')
    expect((caught as ProcessorRejection).meta?.dropSourceAliases).toBeUndefined()

    expect(await readAliases('b')).toEqual(['distinct'])
  })
})

describe('alias.collision — self-reclaim is not a collision', () => {
  it('a block re-asserting its own alias commits normally', async () => {
    const id = await seatAt('Self', 'Self')

    // Re-write the same alias property — same-tx sync should NOT
    // detect a collision because the claimant is this block itself.
    await env.repo.tx(
      tx => tx.setProperty(id, aliasesProp, ['Self']),
      {scope: ChangeScope.BlockDefault},
    )

    expect(await readAliases(id)).toEqual(['Self'])
  })
})

// ──── Regression: collision detection must not assume id provenance ────
//
// Pre-`tx.aliasLookup` implementations walked `computeAliasSeatId(alias,
// ws, 0..N)` to find claimants. That assumed every claimant's id lives
// in the seat-id space for the alias it claims — true for blocks
// created via `ensureAliasTarget`, false in three places that show
// up in real usage:
//
//   1. A block created via `tx.create` with an arbitrary id later
//      acquires an alias (user types its title, edits the chip, etc).
//   2. A block originally seat-id-keyed for alias α gets renamed to
//      alias β — its id no longer matches `computeAliasSeatId(β, ...)`.
//   3. A block seat-id-keyed at slot N (post-rename / post-tombstone)
//      claims an alias whose canonical seat is occupied by a
//      different live block.
//
// All three reach the same conclusion through `block_aliases` (the
// trigger-maintained index), regardless of id. These tests pin
// detection for each, parametrized across A1 / AR1 / direct-claim
// paths so a future regression in any code path that bypasses the
// trigger-maintained index breaks at least one test.

describe('alias.collision — detects claimants regardless of id provenance', () => {
  /** Returns a fresh BlockDefault tx that throws when sync rejects. */
  const tryClaim = async (
    fn: () => Promise<void>,
  ): Promise<ProcessorRejection | null> => {
    try { await fn() } catch (err) {
      if (err instanceof ProcessorRejection) return err
      throw err
    }
    return null
  }

  /** Three ways an alias claimant ends up in `block_aliases`. Every
   *  collision-detection variant below runs against ALL three. */
  const claimantScenarios = [
    {
      name: 'seat-id (canonical)',
      seat: async (alias: string): Promise<{id: string; title: string}> => {
        const id = await seatAt(alias, `${alias} page`)
        return {id, title: `${alias} page`}
      },
    },
    {
      name: 'explicit non-seat id',
      seat: async (alias: string): Promise<{id: string; title: string}> => {
        const id = `explicit-${alias}-abc`
        await seatAtExplicitId(id, alias, `${alias} page`)
        return {id, title: `${alias} page`}
      },
    },
    {
      name: 'seat originally for a different alias then renamed',
      seat: async (alias: string): Promise<{id: string; title: string}> => {
        // Block created via `seatAt('Other')` lives at the seat for
        // 'Other'. Renaming its alias to `alias` leaves the id at
        // `computeAliasSeatId('Other', ...)` — NOT
        // `computeAliasSeatId(alias, ...)`. The block_aliases trigger
        // updates the index for the new alias.
        const id = await seatAt('Other', 'Other page')
        await env.repo.tx(async tx => {
          await tx.update(id, {content: `${alias} page`})
          await tx.setProperty(id, aliasesProp, [alias])
        }, {scope: ChangeScope.BlockDefault})
        await flush()
        return {id, title: `${alias} page`}
      },
    },
  ] as const

  for (const scenario of claimantScenarios) {
    describe(`claimant created via: ${scenario.name}`, () => {
      it('A1-style (content edit adds new claim) → collision', async () => {
        const claimant = await scenario.seat('Taken')
        await env.repo.tx(async tx => {
          await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'mine'})
          await tx.setProperty('b', aliasesProp, ['mine'])
        }, {scope: ChangeScope.BlockDefault})
        await flush()

        const rejection = await tryClaim(() =>
          env.repo.mutate.setContent({id: 'b', content: 'Taken'}),
        )
        expect(rejection).toBeInstanceOf(ProcessorRejection)
        expect(rejection!.code).toBe('alias.collision')
        expect(rejection!.meta?.conflictingBlockId).toBe(claimant.id)
        expect(rejection!.meta?.conflictingBlockTitle).toBe(claimant.title)
      })

      it('AR1-style (alias swap to taken name) → collision', async () => {
        const claimant = await scenario.seat('Foo')
        await env.repo.tx(async tx => {
          await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Bar'})
          await tx.setProperty('b', aliasesProp, ['Bar'])
        }, {scope: ChangeScope.BlockDefault})
        await flush()

        const rejection = await tryClaim(() =>
          env.repo.tx(
            tx => tx.setProperty('b', aliasesProp, ['Foo']),
            {scope: ChangeScope.BlockDefault},
          ),
        )
        expect(rejection).toBeInstanceOf(ProcessorRejection)
        expect(rejection!.meta?.conflictingBlockId).toBe(claimant.id)
      })

      it('direct-claim (alias added alongside existing) → collision', async () => {
        const claimant = await scenario.seat('Shared')
        await env.repo.tx(async tx => {
          await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'distinct'})
          await tx.setProperty('b', aliasesProp, ['distinct'])
        }, {scope: ChangeScope.BlockDefault})
        await flush()

        const rejection = await tryClaim(() =>
          env.repo.tx(
            tx => tx.setProperty('b', aliasesProp, ['distinct', 'Shared']),
            {scope: ChangeScope.BlockDefault},
          ),
        )
        expect(rejection).toBeInstanceOf(ProcessorRejection)
        expect(rejection!.meta?.conflictingBlockId).toBe(claimant.id)
      })
    })
  }
})

describe('alias.collision — claimant whose alias was renamed after creation', () => {
  it('detects collision on the renamed alias, even though the original seat-id is for a different alias', async () => {
    // Concrete narrative of the regression class:
    //   1. User creates a page "Foo" → seat-id slot 0 for "Foo" holds
    //      block A.
    //   2. User renames A's alias to "Bar" via AR1. Block A now claims
    //      "Bar"; its id is still computeAliasSeatId("Foo", ws, 0).
    //   3. User creates a fresh block and tries to claim "Bar".
    //
    // The buggy seat-id probe would walk computeAliasSeatId("Bar", ws,
    // 0..N) — A's id matches none of those, so the probe returns null
    // (no claimant), and the second block silently claims a name
    // already taken.
    const seatA = await seatAt('Foo', 'Foo')
    await env.repo.tx(async tx => {
      await tx.update(seatA, {content: 'Bar'})
      await tx.setProperty(seatA, aliasesProp, ['Bar'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    // Sanity: the seat-id for 'Foo' is held by a block whose current
    // alias is 'Bar'. Computed seat for 'Bar' (slot 0) is a DIFFERENT
    // id — the buggy probe would walk past empty slot at that
    // computed-seat-for-Bar id and report no claimant.
    expect(seatA).not.toBe(/* trivially */ 'computed-seat-for-Bar')
    expect(await readAliases(seatA)).toEqual(['Bar'])

    await env.repo.tx(async tx => {
      await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'fresh'})
      await tx.setProperty('b', aliasesProp, ['fresh'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    let caught: unknown
    try {
      await env.repo.mutate.setContent({id: 'b', content: 'Bar'})
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).meta?.conflictingBlockId).toBe(seatA)
  })

  it('does NOT report a collision for the abandoned original alias (seat is empty)', async () => {
    // After the rename above, the original alias 'Foo' has no
    // claimant — `block_aliases` no longer indexes 'Foo' for any live
    // block. A new block claiming 'Foo' should succeed.
    const seatA = await seatAt('Foo', 'Foo')
    await env.repo.tx(async tx => {
      await tx.update(seatA, {content: 'Bar'})
      await tx.setProperty(seatA, aliasesProp, ['Bar'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    // New block claims 'Foo' — should commit without rejection.
    await env.repo.tx(async tx => {
      await tx.create({id: 'c', workspaceId: WS, parentId: null, orderKey: 'a2', content: 'Foo'})
      await tx.setProperty('c', aliasesProp, ['Foo'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    expect(await readAliases('c')).toEqual(['Foo'])
  })
})

describe('alias.collision — tombstoned claimants are not collisions', () => {
  it('a soft-deleted block does not block a new claimant of its alias', async () => {
    const seatA = await seatAt('Reusable', 'Reusable')
    await env.repo.tx(tx => tx.delete(seatA), {scope: ChangeScope.BlockDefault})
    await flush()

    // Fresh block claims 'Reusable' — tombstoned claimant is ignored
    // (the block_aliases trigger deletes rows for soft-deleted blocks).
    await env.repo.tx(async tx => {
      await tx.create({id: 'fresh', workspaceId: WS, parentId: null, orderKey: 'a3', content: 'Reusable'})
      await tx.setProperty('fresh', aliasesProp, ['Reusable'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    expect(await readAliases('fresh')).toEqual(['Reusable'])
  })
})

// ──── Regression: restore / undo must re-trigger collision detection ────
//
// Soft-delete removes a row from `block_aliases`, freeing its alias for
// reuse. If another block claims that alias in the gap, restoring (or
// undoing the delete on) the original row would put two live blocks
// in `block_aliases` for the same alias — silent duplication.
//
// Two failure modes the pre-fix code has:
//   1. The processor's `watches` is `['content', 'properties']`. A
//      plain `tx.restore(id)` with no patch only flips `deleted`, so
//      the processor doesn't fire at all.
//   2. Even if it did fire (because the restore included a patch
//      changing content or properties), `planSync` treats
//      `before.deleted=true → after.deleted=false` like a regular
//      update: aliases are unchanged on both sides, so the AR1 /
//      direct-claim diffs see nothing added, and the row's
//      re-emergence as a claimant goes uninspected.
//
// Fix: watch `deleted` and treat a restore (`before.deleted &&
// !after.deleted`) as an insert-like collision-only plan over the
// non-blank afterAliases.

describe('alias.collision — restore / undo re-claims a now-taken alias', () => {
  it('rejects tx.restore when another block has claimed the alias in the gap', async () => {
    const aId = await seatAt('Shared', 'Shared')
    await env.repo.tx(tx => tx.delete(aId), {scope: ChangeScope.BlockDefault})
    await flush()

    // Another block claims 'Shared' while A is tombstoned. No collision
    // here — block_aliases doesn't index deleted A. We give B an
    // explicit non-seat id because `seatAt` uses the deterministic
    // seat-id for the alias, which is still occupied by tombstoned A
    // (soft-delete doesn't free the id, only the alias index entry).
    const bId = 'b-explicit'
    await seatAtExplicitId(bId, 'Shared', 'Shared (B)')

    // Restoring A re-introduces it to block_aliases for 'Shared'. B is
    // already a live claimant — this must reject.
    let caught: unknown
    try {
      await env.repo.tx(tx => tx.restore(aId), {scope: ChangeScope.BlockDefault})
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).code).toBe('alias.collision')
    expect((caught as ProcessorRejection).meta?.alias).toBe('Shared')
    expect((caught as ProcessorRejection).meta?.conflictingBlockId).toBe(bId)
    expect((caught as ProcessorRejection).meta?.attemptedOn).toBe(aId)

    // A is still tombstoned (the restore was rolled back).
    const aRow = await env.read(aId)
    expect(aRow!.deleted).toBe(1)
  })

  it('rejects repo.undo of a delete when the alias was reclaimed in the gap', async () => {
    const aId = await seatAt('Shared', 'Shared')
    await env.repo.tx(tx => tx.delete(aId), {scope: ChangeScope.BlockDefault})
    await flush()

    // Create B as a competing claimant. Real-world this would happen
    // in a different session or via collaborative sync — in either
    // case B's creation isn't part of the user's undo history at the
    // moment they decide to undo their delete. Pop B's entry to
    // simulate that: A's delete becomes the top of the stack.
    await seatAtExplicitId('b-explicit', 'Shared', 'Shared (B)')
    env.repo.undoManager.popUndo(ChangeScope.BlockDefault)

    // Undo the delete — same alias-collision shape as the explicit
    // tx.restore case, exercised via the undo replay path
    // (`txImpl.applyRaw` on the snapshot's `before`).
    await expect(env.repo.undo(ChangeScope.BlockDefault)).rejects.toBeInstanceOf(ProcessorRejection)

    // A still tombstoned.
    const aRow = await env.read(aId)
    expect(aRow!.deleted).toBe(1)
  })

  it('allows tx.restore when no other claimant exists', async () => {
    // Negative case: the alias is genuinely free at restore time.
    const aId = await seatAt('Reusable', 'Reusable')
    await env.repo.tx(tx => tx.delete(aId), {scope: ChangeScope.BlockDefault})
    await flush()

    // No competing claimant created in the gap.
    await env.repo.tx(tx => tx.restore(aId), {scope: ChangeScope.BlockDefault})
    await flush()

    // A back to live, still owns 'Reusable'.
    const aRow = await env.read(aId)
    expect(aRow!.deleted).toBe(0)
    expect(await readAliases(aId)).toEqual(['Reusable'])
  })

  it('allows repo.undo of a delete when no other claimant exists', async () => {
    const aId = await seatAt('Reusable', 'Reusable')
    await env.repo.tx(tx => tx.delete(aId), {scope: ChangeScope.BlockDefault})
    await flush()

    // Stack top is the delete (no follow-up writes). undo pops it.
    expect(await env.repo.undo(ChangeScope.BlockDefault)).toBe(true)
    await flush()

    const aRow = await env.read(aId)
    expect(aRow!.deleted).toBe(0)
    expect(await readAliases(aId)).toEqual(['Reusable'])
  })
})

// ──── Regression: detection must filter SELF from claimant lookup ────
//
// `tx.aliasLookup` reads `block_aliases` and returns the OLDEST
// claimant by `created_at`. The attempting row's own alias write is
// already indexed by the time the same-tx processor runs (the
// trigger fires synchronously inside the writeTransaction). So if
// the attempting row happens to be older than the real conflicting
// claimant, an unfiltered lookup returns the attempting row itself
// — claimant.id === plan.id — and the collision is silently missed.
//
// Fix: pass `excludeId: plan.id` so we ask for the oldest OTHER
// claimant. These tests pin the self-filtering: each scenario seeds
// an OLDER block that later attempts to claim an alias already held
// by a YOUNGER block.

describe('alias.collision — attempting row is older than the conflicting claimant', () => {
  it('rejects AR1-style rename when the renamed block is older than the claimant', async () => {
    // Older block A originally claims 'OriginalA'. Younger block B
    // separately claims 'Target'. A is created first, so A.created_at
    // < B.created_at. User now renames A's alias to 'Target' — B is
    // the real conflicting claimant; A is the attempter.
    const a = await seatAt('OriginalA', 'OriginalA')  // older
    const b = await seatAt('Target', 'Target')         // younger
    void b

    let caught: unknown
    try {
      // A renames its alias from 'OriginalA' to 'Target'.
      // AR1: aliases changed, content matches removed alias.
      await env.repo.tx(async tx => {
        await tx.setProperty(a, aliasesProp, ['Target'])
      }, {scope: ChangeScope.BlockDefault})
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).code).toBe('alias.collision')
    // Crucially: the conflicting block reported is B, not A itself.
    expect((caught as ProcessorRejection).meta?.conflictingBlockId).toBe(b)
    expect((caught as ProcessorRejection).meta?.attemptedOn).toBe(a)

    // A unchanged.
    expect((await env.read(a))!.content).toBe('OriginalA')
    expect(await readAliases(a)).toEqual(['OriginalA'])
  })

  it('rejects A1-style content edit when the editing block is older than the claimant', async () => {
    // Same shape, A1 path: A is older with content 'OriginalA'; B is
    // younger and claims 'Target'. User retypes A's content to
    // 'Target'. Sync's A1 rule would replace A's alias 'OriginalA'
    // with 'Target' — collision against B.
    const a = await seatAt('OriginalA', 'OriginalA')  // older
    const b = await seatAt('Target', 'Target')         // younger

    let caught: unknown
    try {
      await env.repo.mutate.setContent({id: a, content: 'Target'})
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).meta?.conflictingBlockId).toBe(b)
    expect((caught as ProcessorRejection).meta?.attemptedOn).toBe(a)
    expect((await env.read(a))!.content).toBe('OriginalA')
  })

  it('rejects direct-claim addition when the adding block is older than the claimant', async () => {
    const a = await seatAt('OriginalA', 'OriginalA')  // older
    const b = await seatAt('Target', 'Target')         // younger

    let caught: unknown
    try {
      // A adds 'Target' alongside 'OriginalA' — directly-claimed path.
      await env.repo.tx(
        tx => tx.setProperty(a, aliasesProp, ['OriginalA', 'Target']),
        {scope: ChangeScope.BlockDefault},
      )
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).meta?.conflictingBlockId).toBe(b)
    expect(await readAliases(a)).toEqual(['OriginalA'])
  })
})

// ──── Regression: inserts must go through collision detection ────
//
// An earlier `planSync` early-returned on `row.before === null`,
// treating inserts as not-our-concern. That bypassed the V1 "refuse
// the rename atomically" policy for any tx that created a new block
// already claiming a taken alias — `tx.create` + `setProperty` in
// the same tx, common for the alias chip editor on a fresh block.

describe('alias.collision — fresh insert that claims a taken alias', () => {
  it('rejects an insert whose initial alias collides', async () => {
    const claimantId = await seatAt('Taken', 'Taken')

    let caught: unknown
    try {
      await env.repo.tx(async tx => {
        await tx.create({id: 'fresh', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'whatever'})
        await tx.setProperty('fresh', aliasesProp, ['Taken'])
      }, {scope: ChangeScope.BlockDefault})
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).code).toBe('alias.collision')
    expect((caught as ProcessorRejection).meta?.alias).toBe('Taken')
    expect((caught as ProcessorRejection).meta?.conflictingBlockId).toBe(claimantId)

    // Insert rolled back — no row at id 'fresh'.
    expect(await env.read('fresh')).toBeNull()
  })

  it('allows an insert whose initial alias is not yet claimed', async () => {
    // The negative case: an insert with a non-blank alias that doesn't
    // collide must commit normally. Pins that the new insert-path
    // collision-only plan doesn't accidentally reject legitimate fresh
    // claims.
    await env.repo.tx(async tx => {
      await tx.create({id: 'novel', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'whatever'})
      await tx.setProperty('novel', aliasesProp, ['NewName'])
    }, {scope: ChangeScope.BlockDefault})

    expect(await readAliases('novel')).toEqual(['NewName'])
  })

  it('rejects an insert with multiple aliases when any one collides', async () => {
    await seatAt('TakenB', 'TakenB')

    let caught: unknown
    try {
      await env.repo.tx(async tx => {
        await tx.create({id: 'fresh', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'fresh'})
        // First alias is novel; second is taken. Detection must scan
        // every claimed alias, not just the first.
        await tx.setProperty('fresh', aliasesProp, ['NovelA', 'TakenB'])
      }, {scope: ChangeScope.BlockDefault})
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).meta?.alias).toBe('TakenB')
    expect(await env.read('fresh')).toBeNull()
  })

  it('skips blank alias entries on an insert (no spurious rejection)', async () => {
    // The codec writes blank strings literally. The block_aliases
    // trigger indexes them; an unfiltered lookup on '' would match
    // every blank-alias row. The planner filters them out of
    // `claimedAliases` so insert paths don't reject themselves on a
    // shared empty entry.
    await env.repo.tx(async tx => {
      await tx.create({id: 'blank', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'blank'})
      await tx.setProperty('blank', aliasesProp, ['', 'OnlyReal'])
    }, {scope: ChangeScope.BlockDefault})

    expect(await readAliases('blank')).toEqual(['', 'OnlyReal'])
  })

  it('two blocks with blank alias entries do not collide', async () => {
    // `tx.aliasLookup('', ws)` returns null by design (blanks aren't
    // meaningful claims; see txEngine.ts). The uniqueness trigger
    // has to agree — otherwise `'']` on two different blocks (e.g.
    // two notes the user explicitly cleared) would crash the second
    // write with a spurious `alias.collision`.
    await env.repo.tx(async tx => {
      await tx.create({id: 'b1', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'first'})
      await tx.setProperty('b1', aliasesProp, [''])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    await env.repo.tx(async tx => {
      await tx.create({id: 'b2', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'second'})
      await tx.setProperty('b2', aliasesProp, [''])
    }, {scope: ChangeScope.BlockDefault})

    expect(await readAliases('b1')).toEqual([''])
    expect(await readAliases('b2')).toEqual([''])
  })
})

// ──── Regression: RAISE payload must survive control chars in alias text ────
//
// Earlier comments claimed the alias codec rejected control chars,
// so the unit-separator (U+001F) delimiter in the RAISE message
// would be unambiguous. That invariant was false — `codecs.string`
// only checks `typeof === 'string'`. An alias containing U+001F
// would shift the parser fields: the alias-with-separator gets
// split, downstream `attemptedBlockId` becomes a fragment of the
// alias text, and the conflicting-block lookup returns nothing.
// Fix: hex-encode each field in the RAISE so the delimiter is
// guaranteed-distinct from field contents.

describe('alias.collision — RAISE payload tolerates control chars in alias text', () => {
  it('reports the correct alias text when a colliding alias contains U+001F', async () => {
    // Seed the claimant. seatAt forces the codec to accept the
    // control char — we want to verify the trigger + parser cope,
    // not whether the codec policies blanks/control chars (that's
    // an upstream concern).
    const weird = 'Foo\x1fBar'
    await seatAtExplicitId('claimant', weird, 'Claimant title')

    let caught: unknown
    try {
      await env.repo.tx(async tx => {
        await tx.create({id: 'attempter', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'attempter'})
        await tx.setProperty('attempter', aliasesProp, [weird])
      }, {scope: ChangeScope.BlockDefault})
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    // The whole alias survives the encode/decode round-trip — not
    // truncated at the embedded separator.
    expect((caught as ProcessorRejection).meta?.alias).toBe(weird)
    expect((caught as ProcessorRejection).meta?.attemptedOn).toBe('attempter')
    expect((caught as ProcessorRejection).meta?.conflictingBlockId).toBe('claimant')
    expect((caught as ProcessorRejection).meta?.conflictingBlockTitle).toBe('Claimant title')
  })
})

// ──── collisionOrigin: 'create' — rejected source never existed ────
//
// When the colliding claim comes from a block CREATED in the rejected
// tx, the rollback erases the block entirely: there is no source for
// the toast's "Merge into …" action to operate on (the merge mutator
// would throw "source not found"). The trigger-translation path marks
// these rejections `collisionOrigin: 'create'` so the UI can drop the
// merge affordance instead of offering a dead-end button.

describe("alias.collision — collisionOrigin 'create' for sources erased by rollback", () => {
  it("marks a fresh-insert collision with collisionOrigin 'create'", async () => {
    await seatAt('Taken', 'Taken')

    let caught: unknown
    try {
      await env.repo.tx(async tx => {
        await tx.create({id: 'fresh', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'fresh'})
        await tx.setProperty('fresh', aliasesProp, ['Taken'])
      }, {scope: ChangeScope.BlockDefault})
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).meta?.collisionOrigin).toBe('create')
  })

  it('does NOT mark a collision whose source block survives the rollback', async () => {
    await seatAt('Shared', 'Shared')
    await env.repo.tx(async tx => {
      await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'distinct'})
      await tx.setProperty('b', aliasesProp, ['distinct'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    let caught: unknown
    try {
      await env.repo.tx(
        tx => tx.setProperty('b', aliasesProp, ['distinct', 'Shared']),
        {scope: ChangeScope.BlockDefault},
      )
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).meta?.collisionOrigin).toBeUndefined()
  })
})

describe('alias.collision — user-error listener wiring', () => {
  it('fires onUserError with the ProcessorRejection', async () => {
    await seatAt('Taken', 'Taken')
    await env.repo.tx(async tx => {
      await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'mine'})
      await tx.setProperty('b', aliasesProp, ['mine'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    const errors: ProcessorRejection[] = []
    const unsubscribe = env.repo.onUserError(e => errors.push(e))

    try {
      await env.repo.mutate.setContent({id: 'b', content: 'Taken'})
    } catch { /* expected */ }

    unsubscribe()

    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('alias.collision')
    expect(errors[0].meta).toMatchObject({alias: 'Taken', attemptedOn: 'b'})
  })

  it('listener errors are caught + logged, do not poison the throw chain', async () => {
    await seatAt('X', 'X')
    await env.repo.tx(async tx => {
      await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'b'})
      await tx.setProperty('b', aliasesProp, ['b'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    env.repo.onUserError(() => { throw new Error('listener bug') })

    let caught: unknown
    try {
      await env.repo.mutate.setContent({id: 'b', content: 'X'})
    } catch (err) { caught = err }

    // Original ProcessorRejection still propagates (listener crash
    // doesn't replace it).
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
