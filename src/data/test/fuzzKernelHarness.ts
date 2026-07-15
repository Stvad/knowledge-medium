/**
 * Shared harness for the stateful kernel-mutator fuzz suites
 * (`repoMutators.fuzz.test.ts`, `splitMerge.fuzz.test.ts`,
 * `queryHandles.fuzz.test.ts`, `referencesRecompute.fuzz.test.ts`,
 * `defaultActions.fuzz.test.ts` — see docs/fuzzing.md). Extracted from
 * five near-duplicate copies during the PR #371 quality-review cleanup
 * (Batch-3 note below). Sibling of `createTestRepo.ts`; allowed to
 * import the data layer.
 *
 * NOT extracted here: the op-arb/`applyOp` harness itself. queryHandles'
 * trimmed op subset and repoMutators' two-workspace `IdSel` threading
 * have diverged materially enough that forcing a merge now risks
 * behavior drift — each suite still hand-rolls its own `OpSpec`/`opArb`/
 * `applyOp`. TODO(harness): Batch 3 should grow the op harness here once
 * the two-workspace shape stabilizes.
 */
import { expect } from 'vitest'
import {
  BlockNotFoundError,
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
 * splitMerge/queryHandles/referencesRecompute/defaultActions.
 * repoMutators keeps its own two-workspace `IdSel`/`IdPools` variant
 * local (a different shape: `{pool, idx}` resolved against one of two
 * pools, not a single flat list) rather than forcing it through this
 * single-pool signature.
 */
export const pick = (index: number, ids: readonly string[]): string => ids[index % ids.length]

/** Skips `ids[0]` (the seed root) so destructive ops keep the tree
 *  alive — same byte-identical copy as `pick`, present in
 *  splitMerge/queryHandles/referencesRecompute (defaultActions doesn't
 *  need a non-root selector: its op pool never destructively targets a
 *  raw id the way delete/merge/move do). */
export const pickNonRoot = (index: number, ids: readonly string[]): string =>
  ids.length === 1 ? ids[0] : ids[1 + (index % (ids.length - 1))]

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
