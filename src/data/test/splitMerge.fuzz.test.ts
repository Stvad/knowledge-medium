// @vitest-environment node
/**
 * Stateful fuzz suite for content conservation across `repo.mutate.split`
 * and `repo.mutate.merge` — see `src/test/fuzz.ts` for the smoke/deep tier
 * mechanics and `docs/fuzzing.md` §6 for the shared-DB interrupt hazard
 * this file also has to guard against (`inFlightCase` barrier below).
 *
 * ──── Semantics grounding (read from `src/data/mutators.ts` /
 * `src/data/blockMerge.ts` before writing any oracle here) ────
 *
 * `split` (mutators.ts:709-751): callers pass the live `before`/`after`
 * strings explicitly (it does NOT slice `self.content` itself — see the
 * comment at mutators.ts:719-723). It writes `self.content = after`
 * (:726) and creates a NEW block with `content: before` positioned
 * IMMEDIATELY BEFORE `self` in its current parent's child list, via
 * `keyImmediatelyBefore` (:741-743, :744-749). So the split-off block is
 * self's immediate *previous* sibling, not "next" — the task brief that
 * seeded this file guessed "next"; the code says otherwise, so the
 * assertions below follow the code. `self`'s own children are untouched
 * (split never calls `tx.move`/`tx.childrenOf` on them), and the new
 * block starts with none.
 *
 * `merge` (mutators.ts:772-786 → blockMerge.ts:40-100): `into.id ===
 * from.id` is a documented no-op (blockMerge.ts:53), as is merging an
 * already-tombstoned `from` (:62). Merging `from` into one of its own
 * descendants throws `MergeIntoDescendantError` (:72-74) — reachable here
 * once a prior merge has reparented children (see property 4). Otherwise:
 * `from`'s direct children are re-homed to the END of `into`'s child list
 * in their original relative order (:76-83, via `tx.move` + `keysBetween`
 * off `intoChildren.at(-1)`), `from` is soft-deleted (:87), and `into`'s
 * content becomes `computeMergedContent(into.content, from.content,
 * strategy)` (:89-90) — for the default `'concat'` strategy that's
 * `into.content + from.content` exactly (blockMerge.ts:33), no separator.
 * Properties are combined via `mergeProperties` (:91); this suite never
 * sets non-default properties, so that path isn't independently exercised
 * here (it has its own suite: `src/data/mergeProperties.fuzz.test.ts`).
 *
 * ──── Properties ────
 *
 * 1. Split-then-merge identity: split a block at a random offset, then
 *    merge the two pieces back in the direction that reconstructs the
 *    original (`intoId` = the new before-block, `fromId` = the original
 *    after-block — `into.content + from.content === before + after ===
 *    the original content`). Oracle: whole-tree pre-order content
 *    conservation at every step, live block count returns to its
 *    original value, and the surviving block ends up with exactly the
 *    original block's children in their original order.
 * 2. Split conservation: a short sequence of splits (targets may be
 *    freshly split-off blocks, so later splits exercise the new blocks
 *    too). After each split: whole-tree pre-order content is conserved,
 *    the new block is the immediate *previous* sibling of the split
 *    block (per the code, not "next"), the split block's children are
 *    unchanged, and the new block has none.
 * 3. Merge conservation: two distinct direct children of the seed root
 *    (guaranteed siblings; one may carry a single child of its own) are
 *    merged. Oracle: `into`'s content becomes the exact concatenation,
 *    `from` becomes tombstoned, `into`'s children become
 *    `[...intoChildrenBefore, ...fromChildrenBefore]`, and — since
 *    non-adjacent siblings would relocate `from`'s text within the
 *    whole-tree pre-order string (only *adjacent* into→from splits, as
 *    in property 1, conserve the exact concatenation) — the total
 *    character count summed over all live blocks' content is conserved
 *    (concat only moves characters between rows, via JS `.length` sums,
 *    not SQL `LENGTH()`, to stay agnostic to any surrogate-pair content
 *    fast-check's default `fc.string()` may generate).
 * 4. Undo round-trip: a short random sequence of splits/merges (typed
 *    domain rejections are legal outcomes for incoherent pairs, same
 *    allowlist as `repoMutators.fuzz.test.ts`) followed by undo-all and
 *    redo-all. This suite copies `repoMutators.fuzz.test.ts`'s *exact*
 *    full-row-snapshot equality (id/parent_id/order_key/content/
 *    properties_json/references_json, verbatim JSON string compare)
 *    rather than a looser order-key-*rank*-only comparison: undo replays
 *    recorded snapshots, not recomputed placements (see the ParentDeletedError
 *    fix noted in `repoMutators.fuzz.test.ts`'s docblock), so the exact
 *    compare is sound and a rank-only compare would hide a bug that
 *    restores the right order with the wrong stored key.
 *
 * `ROOT` itself is never chosen as a split/merge target/into/from (via
 * `pickNonRoot`, copied from `repoMutators.fuzz.test.ts`) — splitting the
 * seed root would place its before-half as a second workspace-root block,
 * outside `SUBTREE_SQL`'s reach from `ROOT`, which would break the
 * whole-tree pre-order oracle used by properties 1 and 2 for reasons
 * unrelated to what they're testing.
 *
 * Determinism: order-key placement (`fractional-indexing-jittered`,
 * confirmed via `node_modules/fractional-indexing-jittered/lib/index.js`)
 * jitters via `Math.random`, exercised by both split (`keyImmediatelyBefore`)
 * and merge (`keysBetween`) as well as the `createChild` seeding calls —
 * every case pins a seeded LCG over `Math.random` in try/finally, same as
 * `repoMutators.fuzz.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  BlockNotFoundError,
  ChangeScope,
  CycleError,
  DeletedConflictError,
  DuplicateIdError,
  MergeIntoDescendantError,
  NotDeletedError,
  ParentDeletedError,
  ParentNotFoundError,
  ProcessorRejection,
  WorkspaceMismatchError,
} from '@/data/api'
import { cycleScanSql, SUBTREE_SQL } from '@/data/internals/treeQueries'
import type { Repo } from '@/data/repo'

const WS = 'ws-1'
const ROOT = 'root'

const text = fc.string({maxLength: 8})

// ──── shared helpers (subset of repoMutators.fuzz.test.ts's) ────

const pick = (index: number, ids: readonly string[]): string => ids[index % ids.length]
/** Skips the seed root — see the docblock for why. */
const pickNonRoot = (index: number, ids: readonly string[]): string =>
  ids.length === 1 ? ids[0] : ids[1 + (index % (ids.length - 1))]

const preorderContent = async (db: TestDb['db'], rootId: string): Promise<string> => {
  const rows = await db.getAll<{content: string}>(SUBTREE_SQL, [rootId])
  return rows.map(r => r.content).join('')
}

const liveCount = async (db: TestDb['db']): Promise<number> => {
  const rows = await db.getAll<{n: number}>('SELECT COUNT(*) AS n FROM blocks WHERE deleted = 0')
  return rows[0].n
}

const childrenIds = async (db: TestDb['db'], parentId: string): Promise<string[]> => {
  const rows = await db.getAll<{id: string}>(
    'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id', [parentId],
  )
  return rows.map(r => r.id)
}

const blockContent = async (db: TestDb['db'], id: string): Promise<string> => {
  const rows = await db.getAll<{content: string}>('SELECT content FROM blocks WHERE id = ?', [id])
  return rows[0].content
}

const blockParent = async (db: TestDb['db'], id: string): Promise<string> => {
  const rows = await db.getAll<{parent_id: string}>('SELECT parent_id FROM blocks WHERE id = ?', [id])
  return rows[0].parent_id
}

const isDeleted = async (db: TestDb['db'], id: string): Promise<boolean> => {
  const rows = await db.getAll<{deleted: number}>('SELECT deleted FROM blocks WHERE id = ?', [id])
  return rows[0].deleted === 1
}

/** Minimal structural invariants — cycles, live orphans, order-key
 *  collisions among live siblings. The derived-index mirror sweeps in
 *  repoMutators.fuzz.test.ts aren't included: split/merge never write
 *  non-default properties/references in this file, so those indexes stay
 *  empty throughout and a mirror check would add cost without coverage. */
const sweepInvariants = async (db: TestDb['db'], ids: readonly string[]): Promise<void> => {
  const cycles = await db.getAll<{start_id: string}>(cycleScanSql(ids.length), [...ids])
  expect(cycles, 'structural cycle').toEqual([])

  const orphans = await db.getAll<{id: string}>(
    `SELECT b.id FROM blocks b
      WHERE b.deleted = 0 AND b.parent_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM blocks p WHERE p.id = b.parent_id AND p.deleted = 0)`,
  )
  expect(orphans, 'live block under missing/deleted parent').toEqual([])

  const collisions = await db.getAll<{parent_id: string | null; order_key: string; n: number}>(
    `SELECT parent_id, order_key, COUNT(*) AS n FROM blocks
      WHERE deleted = 0 GROUP BY parent_id, order_key HAVING n > 1`,
  )
  expect(collisions, 'order-key collision among live siblings').toEqual([])
}

const seedSpecArb = fc.array(
  fc.record({parent: fc.nat(31), content: text}),
  {minLength: 2, maxLength: 6},
)

/** Builds ROOT plus a small random tree from `specs` — each spec's parent
 *  resolves against the ids created so far (including ROOT), so the
 *  result is always a single valid tree, never a cycle. */
const seedTree = async (
  repo: Repo, specs: ReadonlyArray<{parent: number; content: string}>,
): Promise<string[]> => {
  const ids: string[] = [ROOT]
  for (const spec of specs) {
    const parentId = pick(spec.parent, ids)
    const id = await repo.mutate.createChild({parentId, position: {kind: 'last'}, content: spec.content})
    ids.push(id)
  }
  return ids
}

const seedRoot = async (repo: Repo): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0'})
  }, {scope: ChangeScope.BlockDefault})
}

const withPinnedRandom = async <T>(prngSeed: number, fn: () => Promise<T>): Promise<T> => {
  let lcg = prngSeed
  const realRandom = Math.random
  Math.random = () => {
    lcg = (lcg * 48271) % 2147483647
    return lcg / 2147483647
  }
  try {
    return await fn()
  } finally {
    Math.random = realRandom
  }
}

const drain = async (fn: () => Promise<boolean>): Promise<void> => {
  for (let n = 0; n < 300; n++) {
    if (!(await fn())) return
  }
  throw new Error('undo/redo did not bottom out after 300 steps')
}

// ──── deep-tier interrupt barrier (docs/fuzzing.md §6) ────
//
// Shared across all four properties below: fast-check's
// `interruptAfterTimeLimit` resolves `fc.assert` WITHOUT awaiting the case
// currently executing, so an abandoned case can keep writing to `sharedDb`
// after its `it` block returns — racing the next property's reset/seed
// (and `afterAll`'s cleanup) unless barriered first.
let inFlightCase: Promise<void> | null = null

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await inFlightCase?.catch(() => {})
  await sharedDb.cleanup()
})

// ──── property 1: split-then-merge identity ────

const p1CaseArb = fc.record({
  seed: seedSpecArb,
  targetIx: fc.nat(31),
  offsetSeed: fc.nat(20),
  prngSeed: fc.integer({min: 1, max: 2 ** 31 - 2}),
})

const runP1 = async ({seed, targetIx, offsetSeed, prngSeed}: {
  seed: Array<{parent: number; content: string}>; targetIx: number; offsetSeed: number; prngSeed: number
}): Promise<void> => {
  // Barrier BEFORE pinning: an interrupted deep-tier case keeps running
  // after fc.assert resolves, and its finally would restore Math.random
  // over the pin taken here (Codex review on PR #371).
  await inFlightCase?.catch(() => {})
  return withPinnedRandom(prngSeed, async () => {
  const {db} = sharedDb
  await resetTestDb(db)
  const {repo} = createTestRepo({db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  await seedRoot(repo)
  const ids = await seedTree(repo, seed)

  const targetId = pickNonRoot(targetIx, ids)
  const content = await blockContent(db, targetId)
  const i = content.length === 0 ? 0 : offsetSeed % (content.length + 1)
  const before = content.slice(0, i)
  const after = content.slice(i)

  const originalText = await preorderContent(db, ROOT)
  const originalCount = await liveCount(db)
  const originalChildren = await childrenIds(db, targetId)
  const parentId = await blockParent(db, targetId)

  const newId = await repo.mutate.split({id: targetId, before, after})
  ids.push(newId)

  expect(await preorderContent(db, ROOT), 'split conserves whole-tree pre-order content').toBe(originalText)
  expect(await liveCount(db), 'split increases live count by 1').toBe(originalCount + 1)
  expect(await childrenIds(db, targetId), 'split leaves target children untouched').toEqual(originalChildren)
  expect(await childrenIds(db, newId), 'new block starts with no children').toEqual([])
  const siblingsAfterSplit = await childrenIds(db, parentId)
  expect(siblingsAfterSplit.indexOf(newId), 'new block immediately precedes the split target')
    .toBe(siblingsAfterSplit.indexOf(targetId) - 1)
  await sweepInvariants(db, ids)

  // Merge back in the direction that reconstructs the original content:
  // into = new before-block, from = original after-block.
  await repo.mutate.merge({intoId: newId, fromId: targetId})

  expect(await preorderContent(db, ROOT), 'merge-back restores whole-tree pre-order content').toBe(originalText)
  expect(await liveCount(db), 'merge-back restores live count').toBe(originalCount)
  expect(await isDeleted(db, targetId), 'original block tombstoned by merge').toBe(true)
  expect(await childrenIds(db, newId), 'surviving block re-adopts original children in order').toEqual(originalChildren)
  await sweepInvariants(db, ids)
})
}

describe('split-then-merge identity', () => {
  it('reconstructs content, count, and children', async () => {
    await fc.assert(
      fc.asyncProperty(p1CaseArb, async args => {
        const run = runP1(args)
        inFlightCase = run
        await run
      }),
      fuzzParams(15),
    )
  }, fuzzTestTimeout())
})

// ──── property 2: split conservation over a short sequence ────

const splitOpArb = fc.record({idIx: fc.nat(31), offsetSeed: fc.nat(20)})
const p2CaseArb = fc.record({
  seed: seedSpecArb,
  ops: fc.array(splitOpArb, {minLength: 1, maxLength: 4}),
  prngSeed: fc.integer({min: 1, max: 2 ** 31 - 2}),
})

const runP2 = async ({seed, ops, prngSeed}: {
  seed: Array<{parent: number; content: string}>
  ops: Array<{idIx: number; offsetSeed: number}>
  prngSeed: number
}): Promise<void> => {
  // Barrier BEFORE pinning: an interrupted deep-tier case keeps running
  // after fc.assert resolves, and its finally would restore Math.random
  // over the pin taken here (Codex review on PR #371).
  await inFlightCase?.catch(() => {})
  return withPinnedRandom(prngSeed, async () => {
  const {db} = sharedDb
  await resetTestDb(db)
  const {repo} = createTestRepo({db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  await seedRoot(repo)
  const ids = await seedTree(repo, seed)

  for (const {idIx, offsetSeed} of ops) {
    const targetId = pickNonRoot(idIx, ids)
    const content = await blockContent(db, targetId)
    const i = content.length === 0 ? 0 : offsetSeed % (content.length + 1)
    const before = content.slice(0, i)
    const after = content.slice(i)

    const textBefore = await preorderContent(db, ROOT)
    const countBefore = await liveCount(db)
    const childrenBefore = await childrenIds(db, targetId)
    const parentId = await blockParent(db, targetId)

    const newId = await repo.mutate.split({id: targetId, before, after})
    ids.push(newId)

    expect(await preorderContent(db, ROOT), 'split conserves whole-tree pre-order content').toBe(textBefore)
    expect(await liveCount(db), 'split increases live count by 1').toBe(countBefore + 1)
    expect(await childrenIds(db, targetId), 'split leaves target children untouched').toEqual(childrenBefore)
    expect(await childrenIds(db, newId), 'new block starts with no children').toEqual([])
    const siblingsAfter = await childrenIds(db, parentId)
    expect(siblingsAfter.indexOf(newId), 'new block immediately precedes the split target')
      .toBe(siblingsAfter.indexOf(targetId) - 1)

    await sweepInvariants(db, ids)
  }
})
}

describe('split conservation', () => {
  it('conserves whole-tree content and places the new block correctly, over a sequence', async () => {
    await fc.assert(
      fc.asyncProperty(p2CaseArb, async args => {
        const run = runP2(args)
        inFlightCase = run
        await run
      }),
      fuzzParams(10),
    )
  }, fuzzTestTimeout())
})

// ──── property 3: merge conservation over guaranteed siblings ────

const siblingSpecArb = fc.array(
  fc.record({content: text, child: fc.option(text, {nil: undefined})}),
  {minLength: 2, maxLength: 5},
)

const runP3 = async ({specs, intoIdx, fromIdx, prngSeed}: {
  specs: Array<{content: string; child: string | undefined}>
  intoIdx: number
  fromIdx: number
  prngSeed: number
}): Promise<void> => {
  // Barrier BEFORE pinning: an interrupted deep-tier case keeps running
  // after fc.assert resolves, and its finally would restore Math.random
  // over the pin taken here (Codex review on PR #371).
  await inFlightCase?.catch(() => {})
  return withPinnedRandom(prngSeed, async () => {
  const {db} = sharedDb
  await resetTestDb(db)
  const {repo} = createTestRepo({db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  await seedRoot(repo)

  const ids: string[] = [ROOT]
  const sibs: string[] = []
  for (const spec of specs) {
    const sid = await repo.mutate.createChild({parentId: ROOT, position: {kind: 'last'}, content: spec.content})
    ids.push(sid)
    sibs.push(sid)
    if (spec.child !== undefined) {
      const cid = await repo.mutate.createChild({parentId: sid, position: {kind: 'last'}, content: spec.child})
      ids.push(cid)
    }
  }

  const intoId = sibs[intoIdx]
  const fromId = sibs[fromIdx]

  const allContentBefore = (await db.getAll<{content: string}>('SELECT content FROM blocks WHERE deleted = 0'))
    .reduce((sum, r) => sum + r.content.length, 0)
  const intoContentBefore = await blockContent(db, intoId)
  const fromContentBefore = await blockContent(db, fromId)
  const intoChildrenBefore = await childrenIds(db, intoId)
  const fromChildrenBefore = await childrenIds(db, fromId)

  await repo.mutate.merge({intoId, fromId})

  expect(await blockContent(db, intoId), 'default concat strategy: into.content + from.content, no separator')
    .toBe(intoContentBefore + fromContentBefore)
  expect(await isDeleted(db, fromId), 'from tombstoned by merge').toBe(true)
  expect(await childrenIds(db, intoId), 'from children appended after into children, in order')
    .toEqual([...intoChildrenBefore, ...fromChildrenBefore])

  const allContentAfter = (await db.getAll<{content: string}>('SELECT content FROM blocks WHERE deleted = 0'))
    .reduce((sum, r) => sum + r.content.length, 0)
  expect(allContentAfter, 'total live content length conserved (concat only relocates characters)')
    .toBe(allContentBefore)

  await sweepInvariants(db, ids)
})
}

describe('merge conservation', () => {
  it('concatenates content and adopts children for two distinct siblings', async () => {
    await fc.assert(
      fc.asyncProperty(
        siblingSpecArb.chain(specs =>
          fc.record({
            specs: fc.constant(specs),
            intoIdx: fc.nat(specs.length - 1),
            fromIdx: fc.nat(specs.length - 1),
          }),
        ).filter(({intoIdx, fromIdx}) => intoIdx !== fromIdx),
        fc.integer({min: 1, max: 2 ** 31 - 2}),
        async ({specs, intoIdx, fromIdx}, prngSeed) => {
          const run = runP3({specs, intoIdx, fromIdx, prngSeed})
          inFlightCase = run
          await run
        },
      ),
      fuzzParams(15),
    )
  }, fuzzTestTimeout())
})

// ──── property 4: undo/redo round-trip over split/merge sequences ────

type Op4 =
  | {op: 'split'; idIx: number; offsetSeed: number}
  | {op: 'merge'; intoIx: number; fromIx: number}

const op4Arb: fc.Arbitrary<Op4> = fc.oneof(
  {weight: 1, arbitrary: fc.record({op: fc.constant('split' as const), idIx: fc.nat(31), offsetSeed: fc.nat(20)})},
  {weight: 1, arbitrary: fc.record({op: fc.constant('merge' as const), intoIx: fc.nat(31), fromIx: fc.nat(31)})},
)

const p4CaseArb = fc.record({
  seed: seedSpecArb,
  ops: fc.array(op4Arb, {minLength: 1, maxLength: 8}),
  prngSeed: fc.integer({min: 1, max: 2 ** 31 - 2}),
})

// Domain rejections legal for incoherent split/merge pairs — same
// allowlist as repoMutators.fuzz.test.ts (this file targets a subset of
// the same mutator surface, so reuses its proven-correct set rather than
// re-deriving a narrower one that risks missing a reachable case, e.g.
// ParentDeletedError once a prior merge tombstones a block a later split
// still targets).
const LEGAL_ERRORS = [
  BlockNotFoundError,
  CycleError,
  DeletedConflictError,
  DuplicateIdError,
  MergeIntoDescendantError,
  NotDeletedError,
  ParentDeletedError,
  ParentNotFoundError,
  WorkspaceMismatchError,
]

const assertLegalRejection = (e: unknown, opDesc: string): void => {
  if (LEGAL_ERRORS.some(cls => e instanceof cls)) return
  if (e instanceof ProcessorRejection && e.code === 'alias.collision') return
  // Placement anchors resolve by id under the TARGET parent — the one
  // legal plain-Error rejection (mutators.ts:118/431). Anything else is
  // a bug (Codex review on PR #371: the previous blanket branch accepted
  // every plain Error).
  if (e instanceof Error && /^(position\.(before|after) )?sibling .* not found under /.test(e.message)) return
  throw new Error(`illegal error from ${opDesc}: ${String(e)}`, {cause: e})
}

const liveSnapshot = async (db: TestDb['db']): Promise<string> => {
  const rows = await db.getAll(
    `SELECT id, parent_id, order_key, content, properties_json, references_json
       FROM blocks WHERE deleted = 0 ORDER BY id`,
  )
  return JSON.stringify(rows)
}

const runP4 = async ({seed, ops, prngSeed}: {
  seed: Array<{parent: number; content: string}>
  ops: Op4[]
  prngSeed: number
}): Promise<void> => {
  // Barrier BEFORE pinning: an interrupted deep-tier case keeps running
  // after fc.assert resolves, and its finally would restore Math.random
  // over the pin taken here (Codex review on PR #371).
  await inFlightCase?.catch(() => {})
  return withPinnedRandom(prngSeed, async () => {
  const {db} = sharedDb
  await resetTestDb(db)
  const {repo} = createTestRepo({db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  await seedRoot(repo)
  const ids = await seedTree(repo, seed)
  // Drop the seed setup's undo entries so undo-all bottoms out AT the
  // post-seed state captured below, not further back at bare-root — the
  // fuzzed ops (not the tree setup) are what this property exercises.
  repo.undoManager?.clear()

  const seedSnap = await liveSnapshot(db)

  for (const op of ops) {
    try {
      if (op.op === 'split') {
        const targetId = pickNonRoot(op.idIx, ids)
        const content = await blockContent(db, targetId)
        const i = content.length === 0 ? 0 : op.offsetSeed % (content.length + 1)
        const newId = await repo.mutate.split({id: targetId, before: content.slice(0, i), after: content.slice(i)})
        ids.push(newId)
      } else {
        await repo.mutate.merge({intoId: pickNonRoot(op.intoIx, ids), fromId: pickNonRoot(op.fromIx, ids)})
      }
    } catch (e) {
      assertLegalRejection(e, JSON.stringify(op))
    }
    await sweepInvariants(db, ids)
  }

  const finalSnap = await liveSnapshot(db)

  await drain(() => repo.undo())
  expect(await liveSnapshot(db), 'undo-all returns to seed state').toBe(seedSnap)
  await sweepInvariants(db, ids)

  await drain(() => repo.redo())
  expect(await liveSnapshot(db), 'redo-all returns to final state').toBe(finalSnap)
  await sweepInvariants(db, ids)
})
}

describe('split/merge undo round-trip', () => {
  it('undo-all and redo-all restore exact snapshots', async () => {
    await fc.assert(
      fc.asyncProperty(p4CaseArb, async args => {
        const run = runP4(args)
        inFlightCase = run
        await run
      }),
      fuzzParams(10),
    )
  }, fuzzTestTimeout())
})
