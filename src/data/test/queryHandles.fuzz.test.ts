// @vitest-environment node
/**
 * Stateful fuzz suite for query-handle soundness — see `src/test/fuzz.ts`
 * for the smoke/deep tier mechanics and `docs/fuzzing.md` for suite
 * conventions.
 *
 * Property under test: after an arbitrary sequence of `repo.mutate.*`
 * writes, every LIVE SUBSCRIBED `LoaderHandle` (`src/data/internals/
 * handleStore.ts`) must converge to the same value a completely
 * independent, uncached read of the same query would produce. If a query's
 * `ctx.depend(...)` declarations under-declare (miss a dependency the
 * result actually depends on), the handle silently goes stale and
 * `peek()` diverges from ground truth forever — the class of bug this
 * suite exists to catch. It is the read-side counterpart to
 * `repoMutators.fuzz.test.ts` (which fuzzes the mutator surface itself
 * and checks structural invariants, not handle staleness).
 *
 * ── Settle mechanism (the CRITICAL design question) ──
 *
 * `repo.tx` fans out to `HandleStore.invalidate(...)` SYNCHRONOUSLY in its
 * post-commit walk (`kernelQueries.test.ts` L96-107, `repo.ts`), but
 * `LoaderHandle.invalidate()` (handleStore.ts L792-832) does NOT
 * synchronously re-resolve a matched, subscribed handle: it calls
 * `void this.runLoader(batch).catch(...)` (L831) — fire-and-forget. Both
 * the re-run of the loader (a real `await ctx.db.getAll(...)`, L611) and
 * its notify happen strictly after `repo.tx`'s promise has already
 * resolved. So `peek()` is NOT synchronously up to date the instant `tx`
 * resolves — it settles asynchronously, on a later microtask/macrotask.
 *
 * `kernelQueries.test.ts` established the sound idiom for this
 * (L808-814, L846-849, L902-904): after a write, `await vi.waitFor(() =>
 * expect(handle.peek()).toEqual(<expected>))` — polling `peek()` (never a
 * bare `setTimeout` sleep) until it converges or the default timeout
 * trips. This suite uses the same idiom, with one addition: the
 * "`<expected>`" side must NOT be `await sameHandle.load()` — for a
 * `status:'ready', !stale` handle with no inflight load, `load()`
 * short-circuits to `Promise.resolve(this.value)` (handleStore.ts
 * L546-547), i.e. the exact same cached field `peek()` already reads.
 * Comparing a handle to itself is tautological and would pass even if the
 * dependency declarations were completely wrong (the handle would just
 * never invalidate, and "expected" would silently track "actual" because
 * they're the same object). The fix: read the oracle side through a
 * throwaway `createTestRepo` pointed at the SAME underlying db
 * (`sharedDb.db`) — a fresh `Repo` means a fresh, empty `HandleStore`, so
 * `oracleRepo.query.<name>(args).load()` is always a cold, uncached
 * re-run of the real SQL against the current committed state,
 * independent of whatever dependency-tracking bug we're trying to catch.
 *
 * ── Oracle carve-out: searchByContent membership vs. row freshness ──
 *
 * `searchByContentQuery.resolve` (kernelQueries.ts L1045-1052) passes
 * `{declareRowDeps: false}` to `hydrateBlocks` DELIBERATELY: "Property
 * edits, parent moves, and reference changes on a currently-matched row
 * don't affect whether the row matches — declaring per-row deps would fan
 * out invalidations for free." This is a tested, intentional contract
 * (`kernelQueries.test.ts` L1386 "parent move on a result row does NOT
 * invalidate" and L1427 "non-content property edit on a result row does
 * NOT invalidate" — the latter's comment notes a PRIOR bug over-fired on
 * every property write and was fixed to under-invalidate on purpose). So
 * a `searchByContent` handle's matched-row BlockData can legitimately lag
 * ground truth on property-only edits (alias/type/etc.) or parent moves
 * that don't touch content — full deep-equality against a fresh read
 * would be the WRONG oracle here (confirmed empirically: a deep run
 * caught exactly this on `setAlias` with no other bug present). Every
 * other probed query declares per-row deps by default (`repo.ts` L482:
 * `declareRowDeps = Boolean(ctx)` defaults true) or returns bare ids with
 * nothing to go stale (`childIds` lean path), so only `searchByContent`
 * gets the narrower `project` — comparing the returned id SET (its
 * documented invariant) instead of full record equality.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
  type Handle,
} from '@/data/api'
import { aliasesProp, typesProp } from '@/data/properties'
import type { Repo } from '@/data/repo'

const WS = 'ws-1'
const ROOT = 'root'
const SEED_B1 = 'seed-b1'
const SEED_B2 = 'seed-b2'
const SEED_B3 = 'seed-b3'
/** Content marker for `searchByContent` — long enough to clear the FTS
 *  trigram floor (`BLOCKS_CONTENT_FTS_MIN_QUERY_LENGTH = 3` in
 *  kernelQueries.ts) and distinctive enough not to collide with
 *  fuzz-generated `text` (≤8 random chars). */
const SEARCH_MARKER = 'findme'

// ──── op descriptors — subset of repoMutators.fuzz.test.ts's op arb ────
// Trimmed to the ops that exercise every probed query's dependency axes
// (structure via createChild/move/indent/outdent/delete/restore/split/
// merge; content via setContent/split; properties via setAlias/setType).
// Op-arb shape, LEGAL_ERRORS, pick/pickNonRoot/resolvePos, and applyOp are
// copied wholesale from repoMutators.fuzz.test.ts and trimmed to this subset.

type Pos = {kind: 'first'} | {kind: 'last'} | {kind: 'before' | 'after'; sibling: number}

type OpSpec =
  | {op: 'createChild'; parent: number; pos: Pos; content: string}
  | {op: 'move'; id: number; parent: number; pos: Pos}
  | {op: 'setContent'; id: number; content: string}
  | {op: 'indent' | 'outdent' | 'deleteBlock' | 'restoreBlock'; id: number}
  | {op: 'split'; id: number; before: string; after: string}
  | {op: 'merge'; into: number; from: number}
  | {op: 'setAlias'; id: number; alias: number; clear: boolean}
  | {op: 'setType'; id: number; type: number; clear: boolean}

const ALIAS_POOL = ['ax', 'ay', 'az'] as const
const TYPE_POOL = ['task', 'note'] as const

const sel = fc.nat(31)
const text = fc.string({maxLength: 8})
const posArb: fc.Arbitrary<Pos> = fc.oneof(
  {arbitrary: fc.constant({kind: 'first'} as Pos), weight: 2},
  {arbitrary: fc.constant({kind: 'last'} as Pos), weight: 3},
  {arbitrary: fc.record({kind: fc.constantFrom('before' as const, 'after' as const), sibling: sel}), weight: 2},
)

const opArb: fc.Arbitrary<OpSpec> = fc.oneof(
  {weight: 5, arbitrary: fc.record({op: fc.constant('createChild' as const), parent: sel, pos: posArb, content: text})},
  {weight: 4, arbitrary: fc.record({op: fc.constant('move' as const), id: sel, parent: sel, pos: posArb})},
  {weight: 3, arbitrary: fc.record({op: fc.constant('setContent' as const), id: sel, content: text})},
  {weight: 3, arbitrary: fc.record({op: fc.constantFrom('indent' as const, 'outdent' as const), id: sel})},
  {weight: 2, arbitrary: fc.record({op: fc.constantFrom('deleteBlock' as const, 'restoreBlock' as const), id: sel})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('split' as const), id: sel, before: text, after: text})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('merge' as const), into: sel, from: sel})},
  {weight: 3, arbitrary: fc.record({op: fc.constant('setAlias' as const), id: sel, alias: fc.nat(ALIAS_POOL.length - 1), clear: fc.boolean()})},
  {weight: 3, arbitrary: fc.record({op: fc.constant('setType' as const), id: sel, type: fc.nat(TYPE_POOL.length - 1), clear: fc.boolean()})},
)

// Domain rejections legal for incoherent op combinations (same allowlist
// as repoMutators.fuzz.test.ts — a strict superset of what this trimmed
// op set can actually throw is harmless).
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

const assertLegalRejection = (e: unknown, op: OpSpec): void => {
  if (LEGAL_ERRORS.some(cls => e instanceof cls)) return
  if (e instanceof ProcessorRejection && e.code === 'alias.collision') return
  // Placement anchors resolve by id under the TARGET parent — the one
  // legal plain-Error rejection (mutators.ts:118/431). Anything else is
  // a bug (Codex review on PR #371: the previous blanket branch accepted
  // every plain Error).
  if (e instanceof Error && /^(position\.(before|after) )?sibling .* not found under /.test(e.message)) return
  throw new Error(`illegal error from ${JSON.stringify(op)}: ${String(e)}`, {cause: e})
}

const pick = (index: number, ids: readonly string[]): string => ids[index % ids.length]
const pickNonRoot = (index: number, ids: readonly string[]): string =>
  ids.length === 1 ? ids[0] : ids[1 + (index % (ids.length - 1))]

type ResolvedPos = {kind: 'first'} | {kind: 'last'} | {kind: 'before'; siblingId: string} | {kind: 'after'; siblingId: string}
const resolvePos = (pos: Pos, ids: readonly string[]): ResolvedPos =>
  pos.kind === 'first' || pos.kind === 'last'
    ? pos
    : pos.kind === 'before'
      ? {kind: 'before', siblingId: pick(pos.sibling, ids)}
      : {kind: 'after', siblingId: pick(pos.sibling, ids)}

const applyOp = async (repo: Repo, op: OpSpec, ids: readonly string[]): Promise<string[]> => {
  switch (op.op) {
    case 'createChild':
      return [await repo.mutate.createChild({parentId: pick(op.parent, ids), position: resolvePos(op.pos, ids), content: op.content})]
    case 'move':
      await repo.mutate.move({id: pickNonRoot(op.id, ids), parentId: pick(op.parent, ids), position: resolvePos(op.pos, ids)})
      return []
    case 'setContent':
      await repo.mutate.setContent({id: pick(op.id, ids), content: op.content})
      return []
    case 'indent':
      await repo.mutate.indent({id: pickNonRoot(op.id, ids)})
      return []
    case 'outdent':
      await repo.mutate.outdent({id: pickNonRoot(op.id, ids)})
      return []
    case 'deleteBlock':
      await repo.mutate.delete({id: pickNonRoot(op.id, ids)})
      return []
    case 'restoreBlock':
      await repo.mutate.restore({id: pickNonRoot(op.id, ids)})
      return []
    case 'split':
      return [await repo.mutate.split({id: pickNonRoot(op.id, ids), before: op.before, after: op.after})]
    case 'merge':
      await repo.mutate.merge({intoId: pick(op.into, ids), fromId: pickNonRoot(op.from, ids)})
      return []
    case 'setAlias':
      await repo.mutate.setProperty({
        id: pick(op.id, ids),
        schema: aliasesProp,
        value: op.clear ? [] : [ALIAS_POOL[op.alias]],
      })
      return []
    case 'setType':
      await repo.mutate.setProperty({
        id: pick(op.id, ids),
        schema: typesProp,
        value: op.clear ? [] : [TYPE_POOL[op.type]],
      })
      return []
  }
}

// ──── probe pool ────
// One handle per required query name (kernelQueries.ts KERNEL_QUERIES),
// covering every declared Dependency kind used by this op set: row
// (subtree/ancestors), parent-edge (subtree/children/childIds), plugin
// channels (byType/aliasLookup/searchByContent). Targets for the
// structural probes are resolved against the SEED ids only (they must
// exist at subscribe time, before any fuzzed op runs) — same
// index-modulo-length resolution style as op targets, so shrinking stays
// meaningful.
interface Probe {
  name: string
  args: Record<string, unknown>
  /** Narrows a raw query result to the slice this query actually
   *  guarantees is fresh — see the "Oracle carve-out" docblock above.
   *  Identity (full deep-equality) unless overridden. */
  project?: (value: unknown) => unknown
}

const idSet = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(b => (b as {id: string}).id).sort() : value

const seedIds = [ROOT, SEED_B1, SEED_B2, SEED_B3] as const

const buildProbes = (targets: readonly number[]): Probe[] => [
  {name: 'subtree', args: {id: pick(targets[0], seedIds)}},
  {name: 'children', args: {id: pick(targets[1], seedIds)}},
  {name: 'childIds', args: {id: pick(targets[2], seedIds)}},
  {name: 'ancestors', args: {id: pick(targets[3], seedIds)}},
  {name: 'byType', args: {workspaceId: WS, type: TYPE_POOL[0]}},
  {name: 'byType', args: {workspaceId: WS, type: TYPE_POOL[1]}},
  {name: 'aliasLookup', args: {workspaceId: WS, alias: ALIAS_POOL[0]}},
  {name: 'aliasLookup', args: {workspaceId: WS, alias: ALIAS_POOL[1]}},
  // project: id-set only — see "Oracle carve-out" docblock.
  {name: 'searchByContent', args: {workspaceId: WS, query: SEARCH_MARKER}, project: idSet},
]

const probeLabel = (p: Probe): string => `${p.name}(${JSON.stringify(p.args)})`

/** Independent, uncached ground truth: a throwaway `Repo` over the SAME
 *  db gets a brand-new, empty `HandleStore`, so every `.load()` here is a
 *  cold re-run of the real SQL against the currently-committed state —
 *  see the module docblock for why this (not `sameHandle.load()`) is the
 *  sound oracle. Read-only: never call `.mutate`/`.tx` on this repo. */
const freshValues = async (probes: readonly Probe[]): Promise<unknown[]> => {
  const {repo: oracle} = createTestRepo({db: sharedDb.db, user: {id: 'oracle'}})
  oracle.setActiveWorkspaceId(WS)
  return Promise.all(probes.map(p => oracle.query[p.name](p.args).load()))
}

/** Settle + assert: for every subscribed handle, poll `peek()` (never a
 *  bare sleep — see module docblock) until it matches the independent
 *  fresh read, and confirm it didn't land in an error state along the
 *  way. `fresh` is computed ONCE up front — sound because no further
 *  writes happen between computing it and the assertions below (the DB
 *  is quiescent at this point in `runCase`). */
const settleAndVerify = async (handles: readonly Handle<unknown>[], probes: readonly Probe[]): Promise<void> => {
  const fresh = await freshValues(probes)
  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i]
    const probe = probes[i]
    const label = probeLabel(probe)
    const project = probe.project ?? ((v: unknown) => v)
    await vi.waitFor(() => {
      expect(handle.status(), `${label} handle status`).not.toBe('error')
      expect(project(handle.peek()), `${label} peek() vs fresh load()`).toEqual(project(fresh[i]))
    })
  }
}

// ──── execution ────

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await inFlightCase?.catch(() => {})
  await sharedDb.cleanup()
})

/** Deep-tier hazard: fast-check's `interruptAfterTimeLimit` resolves
 *  `fc.assert` WITHOUT awaiting the case that's currently executing — see
 *  docs/fuzzing.md §6 and repoMutators.fuzz.test.ts's `inFlightCase`
 *  docblock. This suite shares `sharedDb.db` across cases the same way,
 *  so it needs the identical barrier. */
let inFlightCase: Promise<void> | null = null

type CaseArgs = {ops: OpSpec[]; probeTargets: number[]; prngSeed: number}

const caseArb = fc.record({
  // ≤ 15 ops — this suite's oracle cost (an independent fresh read per
  // probe) is per-CASE, not per-op, so the budget is dominated by
  // fc-run-count × op-count, not op-count alone.
  ops: fc.array(opArb, {minLength: 1, maxLength: 15}),
  probeTargets: fc.array(fc.nat(seedIds.length - 1), {minLength: 4, maxLength: 4}),
  prngSeed: fc.integer({min: 1, max: 2 ** 31 - 2}),
})

const runCase = async ({ops, probeTargets, prngSeed}: CaseArgs): Promise<void> => {
  // Seeded LCG over Math.random — order-key jitter is the only other
  // nondeterminism in the mutator stack; pinning it keeps shrink/replay
  // sound (see repoMutators.fuzz.test.ts).
  let lcg = prngSeed
  const realRandom = Math.random
  Math.random = () => {
    lcg = (lcg * 48271) % 2147483647
    return lcg / 2147483647
  }
  const unsubs: Array<() => void> = []
  try {
    await resetTestDb(sharedDb.db)
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    repo.setActiveWorkspaceId(WS)
    await repo.tx(async tx => {
      await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: SEED_B1, workspaceId: WS, parentId: ROOT, orderKey: 'a0', content: SEARCH_MARKER})
      await tx.create({id: SEED_B2, workspaceId: WS, parentId: ROOT, orderKey: 'a1'})
      await tx.create({id: SEED_B3, workspaceId: WS, parentId: SEED_B1, orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})
    repo.undoManager?.clear()

    const probes = buildProbes(probeTargets)
    // Hold strong refs to every handle for the lifetime of the case —
    // handleStore.ts L74-ish: an unreferenced handle GCs (default 5s
    // timer) and would silently stop tracking invalidations.
    const handles: Handle<unknown>[] = probes.map(p => {
      const handle = repo.query[p.name](p.args) as Handle<unknown>
      unsubs.push(handle.subscribe(() => {}))
      return handle
    })

    const ids: string[] = [...seedIds]
    for (const op of ops) {
      try {
        ids.push(...await applyOp(repo, op, ids))
      } catch (e) {
        assertLegalRejection(e, op)
      }
    }

    await settleAndVerify(handles, probes)
  } finally {
    for (const unsub of unsubs) unsub()
    Math.random = realRandom
  }
}

describe('query handle soundness', () => {
  it('every subscribed handle converges to an independent fresh read after a mutation sequence', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async args => {
        const run = runCase(args)
        inFlightCase = run
        await run
      }),
      fuzzParams(8),
    )
  }, fuzzTestTimeout())

  // Non-vacuity canary: the equality oracle above only bites if the
  // subscribed queries' values actually move across a sequence — a
  // handle that never invalidates would trivially "match" a fresh read
  // computed from the same never-changing rows. Pins that each probed
  // query's value provably CHANGES under a deterministic sequence
  // exercising its declared dependency axis (structure, live-set
  // membership, alias/type property writes, content).
  it('every probed query value provably changes across a deterministic sequence', async () => {
    await inFlightCase?.catch(() => {})
    await resetTestDb(sharedDb.db)
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    repo.setActiveWorkspaceId(WS)
    const MID = 'canary-mid'
    const P1 = 'canary-p1'
    await repo.tx(async tx => {
      await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: MID, workspaceId: WS, parentId: ROOT, orderKey: 'a0'})
      await tx.create({id: P1, workspaceId: WS, parentId: ROOT, orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault})
    repo.undoManager?.clear()

    const probes: Probe[] = [
      {name: 'subtree', args: {id: ROOT}},
      {name: 'children', args: {id: ROOT}},
      {name: 'childIds', args: {id: ROOT}},
      {name: 'ancestors', args: {id: P1}},
      {name: 'byType', args: {workspaceId: WS, type: TYPE_POOL[0]}},
      {name: 'aliasLookup', args: {workspaceId: WS, alias: ALIAS_POOL[0]}},
      {name: 'searchByContent', args: {workspaceId: WS, query: SEARCH_MARKER}},
    ]
    const unsubs: Array<() => void> = []
    try {
      const handles = probes.map(p => {
        const handle = repo.query[p.name](p.args) as Handle<unknown>
        unsubs.push(handle.subscribe(() => {}))
        return handle
      })
      const before = await Promise.all(handles.map(h => h.load()))

      // Structure + live-set membership (subtree/children/childIds/
      // searchByContent): a new descendant with the search marker.
      await repo.mutate.createChild({parentId: ROOT, position: {kind: 'last'}, content: SEARCH_MARKER})
      // Ancestor-chain (ancestors): reparent p1 under mid.
      await repo.mutate.move({id: P1, parentId: MID, position: {kind: 'last'}})
      // Type property (byType).
      await repo.mutate.setProperty({id: P1, schema: typesProp, value: [TYPE_POOL[0]]})
      // Alias property (aliasLookup).
      await repo.mutate.setProperty({id: P1, schema: aliasesProp, value: [ALIAS_POOL[0]]})

      for (let i = 0; i < handles.length; i++) {
        const label = probeLabel(probes[i])
        await vi.waitFor(() => {
          expect(handles[i].status(), `${label} handle status`).not.toBe('error')
          expect(handles[i].peek(), `${label} changed from seed value`).not.toEqual(before[i])
        })
      }
    } finally {
      for (const unsub of unsubs) unsub()
    }
  })
})
