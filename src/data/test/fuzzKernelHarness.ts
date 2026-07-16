/**
 * Shared harness for the stateful kernel-mutator fuzz suites
 * (`repoMutators.fuzz.test.ts`, `splitMerge.fuzz.test.ts`,
 * `queryHandles.fuzz.test.ts`, `referencesRecompute.fuzz.test.ts`,
 * `defaultActions.fuzz.test.ts` — see docs/fuzzing.md). Extracted from
 * five near-duplicate copies during the PR #371 quality-review cleanup
 * (Batch-3 note below). Sibling of `createTestRepo.ts`; allowed to
 * import the data layer.
 *
 * Batch 3 (this pass): the op-arb/`applyOp` harness itself — `IdSel`
 * (generalized from repoMutators' two-workspace-only `{pool: 0|1; idx}`
 * to N-pool `{pool: number; idx}`), `KernelOpSpec`/`kernelOpArb`, and
 * `applyKernelOp` — is now extracted, generalized to N id pools, so an
 * upcoming two-repo convergence fuzzer can reuse the exact same op
 * vocabulary with per-device pools (excluding `undo`/`redo` via
 * `kernelOpArb`'s `exclude` option). `repoMutators.fuzz.test.ts` adopts
 * it directly (2 pools, default weights). See "kernel op harness" below.
 *
 * NOT extracted: queryHandles' trimmed op subset. Its `OpSpec` targets
 * are plain `number` indices into a single flat id array (no `IdSel`/
 * pool concept at all — it only ever runs one workspace), it drops
 * `createSiblingAbove`/`Below`/`insertChildren`/`moveVertical`/
 * `setReferences`/`undo`/`redo` entirely, and its per-field weights
 * differ from `KernelOpSpec`'s for the ops it keeps: `setContent` is
 * weight 3 there vs weight 2 here, `setAlias`/`setType` are weight 3
 * there vs weight 2 here (createChild/move/indent/outdent/deleteBlock/
 * restoreBlock/split/merge all happen to match). Forcing it onto
 * `kernelOpArb` would mean either (a) wrapping every plain-`number`
 * target in a synthetic single-pool `IdSel`, which adds an indirection
 * with no behavioral payoff for a suite that never has a second pool, or
 * (b) changing its op weights to match `KernelOpSpec`, which is a
 * behavior change to a suite this task was told not to touch. Genuinely
 * adoptable ops/shapes (createChild/move/setContent/indent/outdent/
 * deleteBlock/restoreBlock/split/merge/setAlias/setType) line up 1:1
 * with `KernelOpSpec`'s fields once wrapped in `{pool: 0, idx}`; a
 * future pass that's allowed to touch `queryHandles.fuzz.test.ts` could
 * migrate it onto `kernelOpArb(idSelArb({pools: 1}), {exclude: [...]})`
 * with custom per-op weights (not yet a parameter `kernelOpArb`
 * exposes), at the cost of re-verifying its probe-invalidation
 * properties still fire identically under the new weight distribution.
 */
import { expect } from 'vitest'
import fc from 'fast-check'
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
  ParentWorkspaceMismatchError,
  ProcessorRejection,
  WorkspaceMismatchError,
} from '@/data/api'
import { cycleScanSql } from '@/data/internals/treeQueries'
import type { TestDb } from '@/data/test/createTestDb'
import { aliasesProp, typesProp } from '@/data/properties'
import type { Repo } from '@/data/repo'

// ──── legal-rejection allowlist ────

/**
 * Domain rejections that are LEGAL outcomes for an incoherent op/case —
 * union of the five suites' allowlists (diffed byte-for-byte before this
 * merge; the only divergences were `ParentWorkspaceMismatchError`, below,
 * and whether the caller passed a raw op object or a pre-stringified
 * description — see `assertLegalKernelRejection`'s `desc` param).
 *
 * `ParentWorkspaceMismatchError` is reachable only in repoMutators'
 * two-workspace universe (a reparent whose target parent lives in the
 * other seeded workspace — see `requireParentInWorkspace`,
 * `src/data/internals/txEngine.ts`); the other four suites run a single
 * workspace, so their op sets can never throw it. Including it in the
 * shared union for suites that can't produce it doesn't weaken their
 * no-illegal-errors oracle — an error class that can't fire simply never
 * matches `some(cls => e instanceof cls)` there; it only shrinks the set
 * of errors those suites would flag as illegal if the surrounding
 * product code ever changed to make it reachable, which is a
 * theoretical (not observed) risk, not a live weakening of a property
 * these suites currently exercise.
 */
const LEGAL_ERRORS = [
  BlockNotFoundError,
  CycleError,
  DeletedConflictError,
  DuplicateIdError,
  MergeIntoDescendantError,
  NotDeletedError,
  ParentDeletedError,
  ParentNotFoundError,
  ParentWorkspaceMismatchError,
  WorkspaceMismatchError,
]

/**
 * Throws unless `e` is a legal, expected rejection for an incoherent
 * op/case combination:
 *  - one of `LEGAL_ERRORS` above;
 *  - a `ProcessorRejection` with code `'alias.collision'` — claiming an
 *    alias another live block owns is a legal user-facing rejection
 *    (`block_aliases_workspace_alias_unique`); any other
 *    `ProcessorRejection` from a kernel-only runtime is a bug;
 *  - a plain `Error` matching `sibling .* not found under` — placement
 *    anchors resolve by id under the TARGET parent, so an op whose
 *    anchor sibling lives elsewhere (including in another workspace) is
 *    a legal incoherent-op rejection; `mutators.ts` throws plain `Error`
 *    for it (`mutators.ts:118` for `position.before/after`, used by
 *    `createChild`/`move`/`createSibling*`/`insertChildren`'s shared
 *    `orderKeyForInsert` helper, and `mutators.ts:431` for
 *    `insertChildren`'s own anchor lookup — NOT `split`; its `ix < 0`
 *    case silently falls back to `keyBetween(null, self.orderKey)`
 *    rather than throwing). Only this exact message shape — any other
 *    plain `Error` is a bug (Codex review on PR #371: the previous
 *    `e.constructor === Error` branch accepted them all).
 *
 * `desc` is a caller-formatted description of the op/case that produced
 * `e` (e.g. `JSON.stringify(op)`, or a hand-built label) — callers own
 * the formatting since the op shape differs per suite.
 */
export const assertLegalKernelRejection = (e: unknown, desc: string): void => {
  if (LEGAL_ERRORS.some(cls => e instanceof cls)) return
  if (e instanceof ProcessorRejection && e.code === 'alias.collision') return
  if (e instanceof Error && /^(position\.(before|after) )?sibling .* not found under /.test(e.message)) return
  throw new Error(`illegal error from ${desc}: ${String(e)}`, {cause: e})
}

// ──── id selection ────

/**
 * Single-pool index-modulo-length id resolution — byte-identical across
 * splitMerge/queryHandles/referencesRecompute/defaultActions. For an
 * N-pool `IdSel` (repoMutators' two-workspace shape, or a future
 * per-device convergence pool set), use `pickFromPools` below instead.
 */
export const pick = (index: number, ids: readonly string[]): string => ids[index % ids.length]

/** Skips `ids[0]` (the seed root) so destructive ops keep the tree
 *  alive — same byte-identical copy as `pick`, present in
 *  splitMerge/queryHandles/referencesRecompute (defaultActions doesn't
 *  need a non-root selector: its op pool never destructively targets a
 *  raw id the way delete/merge/move do). Multi-pool sibling:
 *  `pickNonRootFromPools`. */
export const pickNonRoot = (index: number, ids: readonly string[]): string =>
  ids.length === 1 ? ids[0] : ids[1 + (index % (ids.length - 1))]

// ──── kernel op harness ────
// `IdSel`/`KernelOpSpec`/`kernelOpArb`/`applyKernelOp` — the op
// vocabulary repoMutators.fuzz.test.ts fuzzes the kernel mutator surface
// with, generalized from a hardcoded two-workspace universe to N id
// pools so a future two-repo convergence fuzzer can reuse it with
// per-device pools. Moved verbatim from repoMutators.fuzz.test.ts except
// where noted.

/** Which id pool an op argument resolves against, plus a raw index into
 *  that pool. Generalized from repoMutators' `{pool: 0 | 1; idx: number}`
 *  (two workspaces) to an arbitrary pool count — `idSelArb` below is what
 *  constrains `pool` to a live range for a given pool count. */
export type IdSel = {pool: number; idx: number}

export type KernelPos = {kind: 'first'} | {kind: 'last'} | {kind: 'before' | 'after'; sibling: IdSel}

/** The kernel-mutator op vocabulary, verbatim from repoMutators'
 *  `OpSpec` (same op names, same fields). */
export type KernelOpSpec =
  | {op: 'createChild'; parent: IdSel; pos: KernelPos; content: string}
  | {op: 'createSiblingAbove' | 'createSiblingBelow'; sibling: IdSel; content: string}
  | {op: 'insertChildren'; parent: IdSel; contents: string[]; pos: KernelPos}
  | {op: 'move'; id: IdSel; parent: IdSel; pos: KernelPos}
  | {op: 'setContent'; id: IdSel; content: string}
  | {op: 'indent' | 'outdent' | 'deleteBlock' | 'restoreBlock'; id: IdSel}
  | {op: 'moveVertical'; id: IdSel; direction: -1 | 1}
  | {op: 'split'; id: IdSel; before: string; after: string}
  | {op: 'merge'; into: IdSel; from: IdSel}
  | {op: 'setAlias'; id: IdSel; alias: number; clear: boolean}
  | {op: 'setType'; id: IdSel; type: number; clear: boolean}
  | {op: 'setReferences'; id: IdSel; refs: Array<{target: IdSel; aliased: boolean; prop: boolean}>}
  | {op: 'undo'} | {op: 'redo'}

// Tiny alias/type pools so collisions (and merge-then-undo alias
// handoffs — the block_aliases_workspace_alias_unique replay
// interaction) happen constantly rather than by generation accident.
export const ALIAS_POOL = ['ax', 'ay', 'az'] as const
export const TYPE_POOL = ['task', 'note'] as const

/** `IdSel` arbitrary factory. `pools` is the number of id pools in play;
 *  `weights` (default `[9, 1]` for 2 pools, uniform for any other count)
 *  controls how often each pool is picked — repoMutators keeps pool 0
 *  (its primary workspace) dominant so most sequences stay a single
 *  coherent tree, with the occasional cross-pool pick making
 *  cross-workspace op combinations reachable at all. For `pools: 1` this
 *  degenerates to always resolving pool 0 (`weights` is ignored — there's
 *  only one pool to pick). */
export const idSelArb = (opts: {pools: number; weights?: readonly number[]}): fc.Arbitrary<IdSel> => {
  const {pools} = opts
  if (pools < 1) throw new Error(`idSelArb: pools must be >= 1, got ${pools}`)
  if (pools === 1) return fc.record({pool: fc.constant(0), idx: fc.nat(31)})

  const weights = opts.weights ?? (pools === 2 ? [9, 1] : Array.from({length: pools}, () => 1))
  if (weights.length !== pools) {
    throw new Error(`idSelArb: weights.length (${weights.length}) must equal pools (${pools})`)
  }
  return fc.record({
    pool: fc.oneof(...weights.map((weight, pool) => ({arbitrary: fc.constant(pool), weight}))),
    idx: fc.nat(31),
  })
}

/** `KernelOpSpec` arbitrary factory — same op set and SAME weights as
 *  repoMutators' original `opArb`, minus any op kinds in
 *  `opts.exclude` (the two-repo convergence fuzzer excludes `'undo'`/
 *  `'redo'`: undo/redo are per-workspace-manager and don't have an
 *  obvious cross-device convergence meaning). `idSel` is the arbitrary
 *  used for every `IdSel`-typed field — pass `idSelArb({pools: N, ...})`
 *  sized for the caller's pool count. Combined multi-kind entries
 *  (`createSiblingAbove`/`Below`, `indent`/`outdent`,
 *  `deleteBlock`/`restoreBlock`) are excluded as a whole if ANY of their
 *  kinds is in `exclude` — no caller needs finer-grained exclusion than
 *  that today. */
export const kernelOpArb = (
  idSel: fc.Arbitrary<IdSel>,
  opts: {exclude?: readonly KernelOpSpec['op'][]} = {},
): fc.Arbitrary<KernelOpSpec> => {
  const exclude = new Set(opts.exclude ?? [])
  const text = fc.string({maxLength: 8})
  const posArb: fc.Arbitrary<KernelPos> = fc.oneof(
    {arbitrary: fc.constant({kind: 'first'} as KernelPos), weight: 2},
    {arbitrary: fc.constant({kind: 'last'} as KernelPos), weight: 3},
    {arbitrary: fc.record({kind: fc.constantFrom('before' as const, 'after' as const), sibling: idSel}), weight: 2},
  )

  const entries: Array<{kinds: readonly KernelOpSpec['op'][]; weight: number; arbitrary: fc.Arbitrary<KernelOpSpec>}> = [
    {kinds: ['createChild'], weight: 5, arbitrary: fc.record({op: fc.constant('createChild' as const), parent: idSel, pos: posArb, content: text})},
    {kinds: ['createSiblingAbove', 'createSiblingBelow'], weight: 2, arbitrary: fc.record({op: fc.constantFrom('createSiblingAbove' as const, 'createSiblingBelow' as const), sibling: idSel, content: text})},
    {kinds: ['insertChildren'], weight: 1, arbitrary: fc.record({op: fc.constant('insertChildren' as const), parent: idSel, contents: fc.array(text, {minLength: 1, maxLength: 3}), pos: posArb})},
    {kinds: ['move'], weight: 4, arbitrary: fc.record({op: fc.constant('move' as const), id: idSel, parent: idSel, pos: posArb})},
    {kinds: ['setContent'], weight: 2, arbitrary: fc.record({op: fc.constant('setContent' as const), id: idSel, content: text})},
    {kinds: ['indent', 'outdent'], weight: 3, arbitrary: fc.record({op: fc.constantFrom('indent' as const, 'outdent' as const), id: idSel})},
    {kinds: ['deleteBlock', 'restoreBlock'], weight: 2, arbitrary: fc.record({op: fc.constantFrom('deleteBlock' as const, 'restoreBlock' as const), id: idSel})},
    {kinds: ['moveVertical'], weight: 2, arbitrary: fc.record({op: fc.constant('moveVertical' as const), id: idSel, direction: fc.constantFrom(-1 as const, 1 as const)})},
    {kinds: ['split'], weight: 2, arbitrary: fc.record({op: fc.constant('split' as const), id: idSel, before: text, after: text})},
    {kinds: ['merge'], weight: 2, arbitrary: fc.record({op: fc.constant('merge' as const), into: idSel, from: idSel})},
    {kinds: ['setAlias'], weight: 2, arbitrary: fc.record({op: fc.constant('setAlias' as const), id: idSel, alias: fc.nat(ALIAS_POOL.length - 1), clear: fc.boolean()})},
    {kinds: ['setType'], weight: 2, arbitrary: fc.record({op: fc.constant('setType' as const), id: idSel, type: fc.nat(TYPE_POOL.length - 1), clear: fc.boolean()})},
    {kinds: ['setReferences'], weight: 2, arbitrary: fc.record({
      op: fc.constant('setReferences' as const),
      id: idSel,
      refs: fc.array(fc.record({target: idSel, aliased: fc.boolean(), prop: fc.boolean()}), {maxLength: 3}),
    })},
    {kinds: ['undo'], weight: 1, arbitrary: fc.constant({op: 'undo'} as KernelOpSpec)},
    {kinds: ['redo'], weight: 1, arbitrary: fc.constant({op: 'redo'} as KernelOpSpec)},
  ]

  const active = exclude.size === 0 ? entries : entries.filter(e => !e.kinds.some(k => exclude.has(k)))
  return fc.oneof(...active.map(({weight, arbitrary}) => ({weight, arbitrary})))
}

/** Resolves an `IdSel` against an N-pool id-pool array — the multi-pool
 *  sibling of `pick` above. `pools[sel.pool]`'s index 0 is that pool's
 *  seed root by convention (callers seed it that way, e.g.
 *  repoMutators.fuzz.test.ts). */
export const pickFromPools = (sel: IdSel, pools: readonly (readonly string[])[]): string => {
  const pool = pools[sel.pool]
  return pool[sel.idx % pool.length]
}

/** Skips the pool's own seed root (index 0) so destructive ops keep that
 *  pool's tree alive — the multi-pool sibling of `pickNonRoot` above. */
export const pickNonRootFromPools = (sel: IdSel, pools: readonly (readonly string[])[]): string => {
  const pool = pools[sel.pool]
  return pool.length === 1 ? pool[0] : pool[1 + (sel.idx % (pool.length - 1))]
}

export type ResolvedPos = {kind: 'first'} | {kind: 'last'} | {kind: 'before'; siblingId: string} | {kind: 'after'; siblingId: string}
export const resolvePos = (pos: KernelPos, pools: readonly (readonly string[])[]): ResolvedPos =>
  pos.kind === 'first' || pos.kind === 'last'
    ? pos
    : pos.kind === 'before'
      ? {kind: 'before', siblingId: pickFromPools(pos.sibling, pools)}
      : {kind: 'after', siblingId: pickFromPools(pos.sibling, pools)}

/** A newly-created block, tagged with the pool (workspace/device) it
 *  belongs to — inferred from whichever existing id (parent/sibling/self)
 *  it was created under, since kernel mutators always inherit the
 *  parent's real `workspaceId` and that id was itself drawn from exactly
 *  one pool. */
export interface KernelCreated {id: string; pool: number}

/** Applies one op; returns any newly created blocks. Verbatim from
 *  repoMutators' `applyOp`, generalized from its hardcoded `IdPools`
 *  2-tuple to an N-pool array. */
export const applyKernelOp = async (
  repo: Repo, op: KernelOpSpec, pools: readonly (readonly string[])[],
): Promise<KernelCreated[]> => {
  switch (op.op) {
    case 'createChild':
      return [{id: await repo.mutate.createChild({parentId: pickFromPools(op.parent, pools), position: resolvePos(op.pos, pools), content: op.content}), pool: op.parent.pool}]
    case 'createSiblingAbove':
      return [{id: await repo.mutate.createSiblingAbove({siblingId: pickNonRootFromPools(op.sibling, pools), content: op.content}), pool: op.sibling.pool}]
    case 'createSiblingBelow':
      return [{id: await repo.mutate.createSiblingBelow({siblingId: pickNonRootFromPools(op.sibling, pools), content: op.content}), pool: op.sibling.pool}]
    case 'insertChildren': {
      const created = await repo.mutate.insertChildren({
        parentId: pickFromPools(op.parent, pools),
        items: op.contents.map(content => ({content})),
        position: resolvePos(op.pos, pools),
      })
      return created.map(id => ({id, pool: op.parent.pool}))
    }
    case 'move':
      await repo.mutate.move({id: pickNonRootFromPools(op.id, pools), parentId: pickFromPools(op.parent, pools), position: resolvePos(op.pos, pools)})
      return []
    case 'setContent':
      await repo.mutate.setContent({id: pickFromPools(op.id, pools), content: op.content})
      return []
    case 'indent':
      await repo.mutate.indent({id: pickNonRootFromPools(op.id, pools)})
      return []
    case 'outdent':
      await repo.mutate.outdent({id: pickNonRootFromPools(op.id, pools)})
      return []
    case 'deleteBlock':
      await repo.mutate.delete({id: pickNonRootFromPools(op.id, pools)})
      return []
    case 'restoreBlock':
      await repo.mutate.restore({id: pickNonRootFromPools(op.id, pools)})
      return []
    case 'moveVertical':
      await repo.mutate.moveVertical({id: pickNonRootFromPools(op.id, pools), direction: op.direction})
      return []
    case 'split':
      return [{id: await repo.mutate.split({id: pickNonRootFromPools(op.id, pools), before: op.before, after: op.after}), pool: op.id.pool}]
    case 'merge':
      await repo.mutate.merge({intoId: pickFromPools(op.into, pools), fromId: pickNonRootFromPools(op.from, pools)})
      return []
    case 'setAlias':
      await repo.mutate.setProperty({
        id: pickFromPools(op.id, pools),
        schema: aliasesProp,
        value: op.clear ? [] : [ALIAS_POOL[op.alias]],
      })
      return []
    case 'setType':
      await repo.mutate.setProperty({
        id: pickFromPools(op.id, pools),
        schema: typesProp,
        value: op.clear ? [] : [TYPE_POOL[op.type]],
      })
      return []
    case 'setReferences': {
      // `references` is a bookkeeping field with no kernel mutator (the
      // references plugin writes it via tx.update post-commit); writing
      // it directly exercises the block_references triggers + the
      // canonicalization path, which no other op reaches. Targets may be
      // tombstones or live in the OTHER workspace — dangling / foreign
      // targets are legal at this layer (only the full audit's
      // dangling_refs check polices them, and it does so per-workspace).
      const sourceId = pickFromPools(op.id, pools)
      const references = op.refs.map(r => {
        const targetId = pickFromPools(r.target, pools)
        return {
          id: targetId,
          alias: r.aliased ? 'ref-alias' : targetId,
          ...(r.prop ? {sourceField: 'refProp'} : {}),
        }
      })
      await repo.tx(async tx => {
        await tx.update(sourceId, {references})
      }, {scope: ChangeScope.BlockDefault})
      return []
    }
    case 'undo':
      await repo.undo()
      return []
    case 'redo':
      await repo.redo()
      return []
  }
}

// ──── snapshots + undo/redo draining ────

/** JSON snapshot of every LIVE block's structural+content columns,
 *  ordered by id — sound as an exact undo/redo round-trip oracle
 *  whenever a suite's op set has no hard-delete-visible asymmetry to
 *  track (i.e. every block created during a sequence that undo can't
 *  hard-delete ends up tombstoned, hence filtered out here on both the
 *  seed and final sides equally). Moved here from splitMerge.
 *  repoMutators needs a STRICTER oracle — including tombstones, to catch
 *  undo corrupting an already-deleted row's content/properties/parent —
 *  so it keeps its own `fullSnapshotRows`/`fullSnapshot` local rather
 *  than using this. */
export const liveSnapshot = async (db: TestDb['db']): Promise<string> => {
  const rows = await db.getAll(
    `SELECT id, parent_id, order_key, content, properties_json, references_json
       FROM blocks WHERE deleted = 0 ORDER BY id`,
  )
  return JSON.stringify(rows)
}

/** Steps `fn` (an `undo()`/`redo()` call) until it reports nothing left
 *  to do, up to a safety cap. Unified from repoMutators (which returned
 *  the step count, unused by every caller) and splitMerge (void) — the
 *  void signature wins since nothing needs the count. */
export const drain = async (fn: () => Promise<boolean>): Promise<void> => {
  for (let n = 0; n < 300; n++) {
    if (!(await fn())) return
  }
  throw new Error('undo/redo did not bottom out after 300 steps')
}

// ──── structural invariant sweep ────

export interface StructuralSweepOptions {
  /** Scopes the order-key-collision check to this workspace's live
   *  siblings — avoids a false positive when two workspaces' seed roots
   *  share `parent_id = null, order_key = 'a0'` and would otherwise look
   *  like colliding siblings of each other (see
   *  repoMutators.fuzz.test.ts, which calls this sweep once per
   *  workspace for exactly this reason). Doesn't restrict the cycle scan
   *  (parent_id chains aren't workspace-scoped: a structurally-reachable
   *  cycle through another workspace's rows must still be caught) or the
   *  orphan check (inherently global). */
  ws: string
  /** Known ids to seed the cycle scan from. Ignored when `allRows` is
   *  set. */
  ids?: readonly string[]
  /** Query every block id in the db fresh, instead of trusting a
   *  maintained `ids` pool — for suites (defaultActions) whose op pool
   *  mints blocks the harness loop doesn't separately track, so a cycle
   *  through a created id would otherwise escape the sweep (Codex review
   *  on PR #371). */
  allRows?: boolean
}

/**
 * Shared structural-invariant core: no cycle, no live block under a
 * missing/deleted parent, no order-key collision among live siblings of
 * one workspace. Used by repoMutators/splitMerge/defaultActions.
 *
 * Deliberately NOT included here (kept suite-local, differing in scope
 * per suite so not a clean fit for a single `ws` parameter):
 *  - the "no block outside the known workspace(s)" check — repoMutators
 *    checks against a two-workspace allowlist, defaultActions against
 *    one; folding both into this single-`ws` signature would either
 *    weaken repoMutators' check or force an API shape beyond what this
 *    cleanup scoped;
 *  - trigger-maintained derived-index mirrors (repoMutators'
 *    `sweepDerivedIndexes`), the `SUBTREE_SQL`-vs-JS-walk differential
 *    (repoMutators' `sweepSubtreeForWorkspace`), and the references
 *    consistency audit (referencesRecompute) — suite-specific by
 *    construction, not duplicated anywhere.
 */
export const sweepStructuralInvariants = async (
  db: TestDb['db'], {ws, ids, allRows}: StructuralSweepOptions,
): Promise<void> => {
  const scanIds = allRows
    ? (await db.getAll<{id: string}>('SELECT id FROM blocks')).map(row => row.id)
    : [...(ids ?? [])]

  // `cycleScanSql` requires at least one id (throws on 0) — a workspace
  // with no known ids yet (e.g. a canary that never seeded ws-2) has
  // nothing to scan from, which is vacuously cycle-free, not an error.
  const cycles = scanIds.length > 0
    ? await db.getAll<{start_id: string}>(cycleScanSql(scanIds.length), scanIds)
    : []
  expect(cycles, 'structural cycle').toEqual([])

  const orphans = await db.getAll<{id: string}>(
    `SELECT b.id FROM blocks b
      WHERE b.deleted = 0 AND b.parent_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM blocks p WHERE p.id = b.parent_id AND p.deleted = 0)`,
  )
  expect(orphans, 'live block under missing/deleted parent').toEqual([])

  const collisions = await db.getAll<{parent_id: string | null; order_key: string; n: number}>(
    `SELECT parent_id, order_key, COUNT(*) AS n FROM blocks
      WHERE deleted = 0 AND workspace_id = ? GROUP BY parent_id, order_key HAVING n > 1`,
    [ws],
  )
  expect(collisions, 'order-key collision among live siblings').toEqual([])
}
