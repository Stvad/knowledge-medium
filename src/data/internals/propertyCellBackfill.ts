/**
 * The properties-as-blocks cell → children pass (§11 slice C).
 *
 * Every block whose `properties_json` holds a registered key gets the field
 * and value CHILD rows that key implies, built by the same helper the live
 * dual-write uses (`materializePropertyChildrenForExistingRow`). Cells are
 * left exactly as they are: this pass ADDS the child representation.
 *
 * IT RUNS ON EITHER SIDE OF THE FLIP, and does a different job on each. Before
 * `properties_migration` reaches `'children'` nothing else maintains the
 * children at all — the live processors are dormant — so the pass RECONCILES:
 * it writes what the cell says and removes what the cell no longer has. After
 * the flip those maintainers are on and the children are the property truth,
 * so the only work left is GAPS, and the pass becomes CREATE-ONLY (see
 * {@link namesPendingMaterialization}). The runbook is flip THEN backfill:
 * flipping a workspace with no children hides nothing, because at `'children'`
 * the cell is still dual-written and still the synchronous read surface, while
 * running the pass first leaves a window in which new machinery is unrecognized
 * and visible.
 *
 * `operator` trigger, so nothing schedules it. Its writes upload — that is the
 * point, one device builds the rows and every other device receives them —
 * which is also why it must not be attempted concurrently by a fleet; the
 * `BackfillCompletionClaim` records who is doing it.
 *
 * RESUMABILITY IS DERIVED, NOT CHECKPOINTED. The candidate query asks the data
 * itself what is left to do, so a run killed halfway simply finds less work
 * next time and no progress state can go stale or disagree with the graph.
 * That is why there is no cursor to persist: the pass is a fixpoint, and
 * `materializePropertyChildrenForExistingRow` is idempotent per row.
 */

import type { BlockData, Tx } from '@/data/api'
import type { WorkspaceBackfill, WorkspaceBackfillContext } from '@/data/facets'
import { CallbackSet } from '@/utils/callbackSet'
import { getPropertyFieldTargetId } from '@/data/propertyChildren'
import { materializePropertyChildrenForExistingRow } from './propertyChildrenProcessor'

export const PROPERTY_CELL_BACKFILL_ID = 'properties:cell-to-children'

/** Rows a writing transaction aims to insert. THE transaction-size knob:
 *  batching by BLOCKS let a heavy-property block multiply the real size, and
 *  at the measured ~6.5 keys per block a 100-block batch held the single
 *  SQLite writer for ~430ms — with every user write and the sync drain queued
 *  behind it, for the length of the run. The spike bisected the same budget
 *  down to 190 and this pass inherits the number. */
export const TARGET_INSERT_ROWS = 190

/** A registered key costs a field row and its value row. Over-counts a key
 *  that is unregistered or already materialized, which errs toward smaller
 *  transactions. */
export const ROWS_PER_KEY = 2

/** Candidates fetched per scan query. Independent of the write budget: this
 *  bounds how often the pass pays for a cursor seek, the budget bounds how
 *  long it holds the writer. */
const SCAN_PAGE = 500

/** What "carries a property" means, for a block aliased `b`. Written once
 *  because the pass needs it in three places and the third is its NEGATION:
 *  the orphan leg below has to select exactly the owners this one cannot see.
 *
 *  `properties_json <> '{}'` is the term that makes it servable by
 *  `idx_blocks_workspace_nonempty_properties` — see that index's comment in
 *  `blockSchema.ts` for why SQLite needs it spelled out.
 *
 *  The trailing EXISTS is not redundant with it: under the NEGATION below,
 *  a NULL bag makes the first two terms NULL and `NOT (NULL)` is NULL, so the
 *  row would fall out of BOTH legs. EXISTS returns a definite 0 and pulls the
 *  whole conjunction false. The column is NOT NULL today, which makes this
 *  belt-and-braces — but it is why the term must not be "simplified" away. */
const CARRIES_A_PROPERTY = `
     b.properties_json <> '{}'
     AND json_valid(b.properties_json)
     AND json_type(b.properties_json) = 'object'
     AND EXISTS (SELECT 1 FROM json_each(b.properties_json))`

/**
 * Blocks carrying any property, oldest id first, with the key count the write
 * budget is drawn against.
 *
 * Deliberately NOT narrowed to "blocks that still owe children". A first
 * attempt compared key count against field-row count, which is not the
 * over-approximation it looks like: an owner with cell key A and a field row
 * for B has one of each and drops out while A is still unmigrated. Any count
 * comparison can be fooled that way, and whether a key is REGISTERED is a
 * question only the JS registry can answer — so SQL selects the superset and
 * `materializePropertyChildrenForExistingRow` is the exact test. A visited row
 * with nothing to do costs one read and no write.
 *
 * `id > ?` paginates rather than `OFFSET`, which would re-walk the prefix per
 * batch. The pass's own creates (field and value rows) carry no properties, so
 * they never enter this result and the scan cannot feed itself.
 */
export const CANDIDATE_SQL = `
  SELECT b.id AS id,
         (SELECT COUNT(*) FROM json_each(b.properties_json)) AS keys
    FROM blocks b
   WHERE b.workspace_id = ?
     AND b.deleted = 0
     AND b.id > ?
     AND ${CARRIES_A_PROPERTY}
   ORDER BY b.id
   LIMIT ?`

/**
 * The complement: owners that still have field rows but no longer satisfy
 * {@link CARRIES_A_PROPERTY}.
 *
 * `namesToReconcile` can only delete the children of a name the OWNER is
 * visited for, and the scan above visits an owner only while its bag still
 * holds something. So removing a block's LAST property left its field row and
 * value row untouched, and no re-run could reach them — the one case the
 * deletion path exists for that it could not see. Post-flip PROJECT rebuilds
 * the cell from those children and the deleted property comes back.
 *
 * Of its narrowing terms only the workspace pair is behaviourally load-bearing
 * (and tested). `is_field_form = 1` and the two `deleted = 0` terms are COST
 * guards: without them the leg selects the parent of nearly every block, and
 * every extra row is then dropped anyway — by `tx.get` for a tombstone, or by
 * `namesToReconcile` finding no field rows. Deleting them fails no test, and
 * should not.
 *
 * Driven off `idx_blocks_field_form`, whose `(workspace_id, parent_id)` prefix
 * makes the GROUP BY and the cursor an ordered index walk. `keys` is the
 * owner's field-row count — these rows only delete, and it keeps a block with
 * hundreds of them from landing in one transaction with everything else.
 *
 * `b.workspace_id = f.workspace_id` is not implied by the parent link: sync
 * arrivals write `blocks` without the tx layer's `requireParentInWorkspace`,
 * so one bad `parent_id` from the server is all it takes. Free — measured
 * within noise.
 *
 * The owner lookup is nested in the field-row loop, so it runs once per FIELD
 * ROW rather than once per owner — measured 297ms against leg one's 129ms on a
 * 1M-row graph, per sweep. Restructuring it (group in a subquery, join once)
 * measured 149ms and needs the leg to carry its own parameter list; declined
 * against a run of minutes, where `CHILD_STATE_SQL` alone costs twice as much.
 */
const ORPHANED_OWNER_SQL = `
  SELECT f.parent_id AS id, COUNT(*) AS keys
    FROM blocks f
    JOIN blocks b ON b.id = f.parent_id
   WHERE f.workspace_id = ?
     AND f.deleted = 0
     AND f.is_field_form = 1
     AND f.parent_id > ?
     AND b.workspace_id = f.workspace_id
     AND b.deleted = 0
     AND NOT (${CARRIES_A_PROPERTY})
   GROUP BY f.parent_id
   ORDER BY f.parent_id
   LIMIT ?`

/** How many property-child rows the workspace has, and when one last changed.
 *
 *  ONLY `n` decides convergence: it moves on a create or a delete, the
 *  structural changes, and the only ones that mean another sweep is owed.
 *  Looping on `t` as well makes the pass diverge on any workspace someone is
 *  looking at — `editorSelection` and `isEditing` are registered properties on
 *  the panel block, so every caret movement rewrites a value child, and four
 *  of them across four multi-minute sweeps end the run unconverged with every
 *  row already written.
 *
 *  `t` is still read, for `editedUnderPass`: moving during the sweep that
 *  converged says the pass was rewriting children from cells that were
 *  changing under it, which the operator needs told even though it must not
 *  buy another sweep. It also backstops the one way `n` alone can mislead — a
 *  sweep whose creates and deletes exactly cancel converges without a
 *  verifying sweep, and a create always moves `t`.
 *
 *  `MAX` is not a general change detector: a rewrite stamped below a
 *  future-stamped peer row leaves it flat. That degeneracy needs clock skew
 *  across devices and only costs a warning, so it is labelled, not guarded. */
const CHILD_STATE_SQL = `
  SELECT COUNT(*) AS n, COALESCE(MAX(b.updated_at), 0) AS t
    FROM blocks b
   WHERE b.workspace_id = ? AND b.deleted = 0
     AND (b.is_field_form = 1
          OR EXISTS (SELECT 1 FROM blocks f
                      WHERE f.id = b.parent_id AND f.is_field_form = 1
                        AND f.workspace_id = b.workspace_id))`

/** How much there is to visit, for a confirmation prompt. Same predicate as
 *  the pass, so the number the user is shown is the number of blocks it will
 *  read — most of which may already be migrated, which is why it surfaces as
 *  "blocks to check". */
export const countPropertyCellBackfillCandidates = async (
  getAll: <T>(sql: string, params?: readonly unknown[]) => Promise<T[]>,
  workspaceId: string,
): Promise<number> => {
  const rows = await getAll<{n: number}>(
    // INDEXED BY, unlike the pass's own scan: with no cursor to anchor it the
    // planner picks `idx_blocks_workspace_active` at realistic property
    // densities and reads `properties_json` off every row in the workspace.
    // This runs before the confirmation dialog, on the UI thread.
    `SELECT COUNT(*) AS n
       FROM blocks b INDEXED BY idx_blocks_workspace_nonempty_properties
      WHERE b.workspace_id = ? AND b.deleted = 0
        AND ${CARRIES_A_PROPERTY}`,
    [workspaceId],
  )
  return rows[0]?.n ?? 0
}

/** Progress fan-out for a surface that wants to show a running count. The pass
 *  runs inside the backfill runner, which has no channel back to whoever asked
 *  for it, and a module registry is the sanctioned shape for that (AGENTS.md:
 *  no untyped window events). Fires per committed batch. */
const progressListeners = new CallbackSet<[PropertyCellBackfillProgress]>(
  'property-cell-backfill',
)

export const onPropertyCellBackfillProgress = (
  listener: (progress: PropertyCellBackfillProgress) => void,
): (() => void) => progressListeners.add(listener)

/** Every count here is scoped to the CURRENT sweep and resets when the next
 *  one starts. Accumulating across sweeps made each of them lie in its own
 *  way: a progress bar reading `scanned/total` sat pinned at 100% for every
 *  sweep after the first, and the failure list — which IS the operator's
 *  repair worklist — carried one entry per bad block per sweep. The last
 *  sweep's numbers are the state of the graph; the earlier ones are history
 *  nobody acts on. */
export interface PropertyCellBackfillProgress {
  /** Blocks read this sweep. */
  blocksScanned: number
  /** Blocks the materializer accepted in full this sweep. Not "blocks
   *  changed" — a block that already had its children is accepted and written
   *  to zero times. NOT a proxy for "anything happened": one junk key on every
   *  block leaves this at zero for a run that migrated all the others, which
   *  is what `valuesMaterialized` is for. */
  blocksMaterialized: number
  /** Property values reconciled this sweep, counting the ones on a block that
   *  also had a failure. */
  valuesMaterialized: number
  /** The same, for the WHOLE run. This is the one that distinguishes a
   *  systematic failure from a handful of bad values, and the per-sweep count
   *  cannot: post-flip the converging sweep is BY DEFINITION the one that found
   *  nothing left pending, so its zero is the normal ending. Testing the
   *  per-sweep count reported a run that migrated everything as "nothing was
   *  migrated — that is a systematic problem", and suppressed the repair
   *  worklist naming the values that actually failed. */
  valuesMaterializedTotal: number
  /** Full passes over the workspace. More than two means blocks kept changing
   *  under the pass. */
  sweeps: number
  /** Property values that could not be materialized this sweep, with the
   *  reason. Reported, never fatal — see {@link materializeRow}. Capped at
   *  {@link MAX_REPORTED_FAILURES}. */
  failures: {blockId: string; reason: string}[]
  /** Owners the orphan leg swept, for the WHOLE run rather than the current
   *  sweep — deliberately: it is the only place the pass reports that it
   *  DELETED anything, and the sweep that deletes is by construction never the
   *  one that converges. An operator who is told nothing about a run whose
   *  only effect was removing children has no way to check it was right. */
  orphanedOwnersSwept: number
  /** Failures this sweep, including any past the cap. Paired with
   *  `blocksMaterialized === 0` it is the signal that the run hit something
   *  SYSTEMATIC — a codec rejecting everything, storage refusing writes —
   *  rather than a handful of bad values, and the operator must be told that
   *  rather than shown "migrated 0 blocks" in green. Deliberately not a throw:
   *  `blocksMaterialized` counts blocks accepted IN FULL, so one junk key on
   *  every block would abort a migration that in fact wrote most of it. */
  failureCount: number
  /** PRE-FLIP ONLY. The final sweep still had to rewrite value children — i.e.
   *  cells were changing while the pass ran, and the children it just built are
   *  behind by however much landed after it visited each block. Create-only
   *  rewrites nothing, so past the flip this can only mean "someone touched a
   *  property", which the dual-write already handled — and the re-run it advises
   *  would do nothing and report the same thing. Convergence
   *  deliberately does not loop on this (see {@link CHILD_STATE_SQL}), so
   *  reporting it is the only thing that tells an operator to run it
   *  again. */
  editedUnderPass: boolean
}

/** Cap on retained failure detail. `failureCount` stays exact; this only
 *  bounds what a pathological graph can accumulate in memory and hand back. */
const MAX_REPORTED_FAILURES = 50

/** Sweeps before giving up. A second sweep is normal — it is what proves the
 *  first one converged. Needing a fifth means the workspace is being edited
 *  faster than the pass runs, and the right answer is to stop and say so
 *  rather than to loop against a live user. */
const MAX_SWEEPS = 4

/**
 * Which property names this row has to be reconciled against — the cell's
 * current keys UNION the ones its existing field rows stand for.
 *
 * The default (current keys only) cannot express a DELETION. If an earlier
 * batch materialized key A and the user then removed A from the cell, a later
 * sweep asks the materializer about the remaining keys, A is never mentioned,
 * and its children survive. Pre-flip nothing else deletes them — the live
 * processor is dormant — so the flip would make those children authoritative
 * and resurrect the property the user deleted. Naming A puts it on the
 * materializer's list, which removes the children of a name the bag no longer
 * has.
 */
const namesToReconcile = async (
  tx: Tx,
  ctx: WorkspaceBackfillContext,
  row: BlockData,
): Promise<string[]> => {
  const names = new Set(Object.keys(row.properties))
  for (const fieldId of await materializedFieldIds(tx, row)) {
    const schema = ctx.resolveFieldSchema(fieldId)
    if (schema) names.add(schema.name)
  }
  return [...names]
}

/** The fieldIds this owner already has LIVE field rows for. One definition
 *  because both name-pickers below need it and §9's named-predicate discipline
 *  is explicit that hand-rolled restatements are the recorded failure mode —
 *  two copies here would be free to drift apart. Same `tx.childrenOf` the
 *  materializer reads, so "already materialized" cannot disagree with the branch
 *  it will actually take. */
const materializedFieldIds = async (tx: Tx, row: BlockData): Promise<Set<string>> => {
  const ids = new Set<string>()
  for (const child of await tx.childrenOf(row.id, undefined)) {
    const fieldId = child.isFieldForm ? getPropertyFieldTargetId(child) : undefined
    if (fieldId !== undefined) ids.add(fieldId)
  }
  return ids
}

/**
 * The create-only subset: cell keys with no field row of their own.
 *
 * This is the whole post-flip contract. Past the flip the CHILDREN are the
 * property truth and the cell is a local, derived read surface — a device that
 * has received value rows from sync and not yet re-projected them holds a
 * stale bag over live children — so reconciling from the cell overwrites real
 * values, and {@link namesToReconcile}'s union half tombstones them. A key
 * with NO field row is the one shape the cell is still authoritative for (§5's
 * pending-materialization rule), and it is exactly the branch
 * `materializePropertyChildrenForExistingRow` CREATES rather than reconciles:
 * filtering to it means the pass can only take that branch.
 *
 * A field row with NO value children is deliberately not treated as a gap:
 * post-flip that projects as "key unset" (§9), which is what deleting the
 * value row means, and re-adding it from the cell would undo the user's edit.
 *
 * A TOMBSTONED field row gets the same treatment. "No live field row" has two
 * causes — history, and a property DELETED through its
 * children on a peer whose owner row has not reached this device — and only the
 * tombstone tells them apart. Without it the pass recreates the property and
 * UPLOADS it, undoing the delete for the fleet. Genuine history carries no
 * tombstone, so this costs the intended path nothing. It does NOT cover an
 * out-of-band HARD delete of a child, which leaves no tombstone to find and
 * whose stale cell key is a known permanent orphan (issue #404).
 */
const namesPendingMaterialization = async (
  tx: Tx,
  ctx: WorkspaceBackfillContext,
  row: BlockData,
): Promise<string[]> => {
  const materialized = await materializedFieldIds(tx, row)
  // Read under the SAME write lock as the materialization it gates. Taken with
  // the candidate scan instead, a tombstone that landed while the batch waited
  // for the writer would be missed — and missing it is the whole failure.
  const reaped = await tx.reapedPropertyFieldTargets(row.id)
  return Object.keys(row.properties).filter(name => {
    const fieldId = ctx.resolveNameSchema(name)?.fieldId
    // An unregistered key has no definition to point a field row AT, so the
    // materializer skips it and it can never leave this set. Excluded rather
    // than carried: post-flip convergence is "a sweep that materialized
    // nothing", and `materializeRow` counts NAMES HANDED to the materializer,
    // so one such key on one block kept every sweep looking like work and the
    // run ended in a give-up — on exactly the graphs `audit-properties` exists
    // to find, and after the flip had landed. Pre-flip they stay on
    // `namesToReconcile`'s list, where convergence is measured on row counts
    // and a skipped name costs nothing.
    if (fieldId === undefined) return false
    return !(materialized.has(fieldId) || reaped.has(fieldId))
  })
}

/**
 * Materialize one row, isolating a name whose cell value will not decode.
 *
 * `materializePropertyChildrenForExistingRow` walks `names` and THROWS at the
 * first one whose cell value fails its codec — legacy junk from a raw
 * `tx.update({properties})`. Refusing is right for a live edit and wrong for a
 * one-time sweep in two ways: unhandled it aborts the migration for the whole
 * graph, and caught per ROW it strands every name after the bad one. The
 * deletion names `namesToReconcile` appends come last, so one junk value on a
 * block silently kept the children of a key the user had DELETED — which the
 * flip would then make authoritative, resurrecting the property.
 *
 * So: one call for the whole list (one `childrenOf`, the common path), and on
 * a throw one call per name. The re-read cost is paid only by rows that are
 * already broken.
 */
const materializeRow = async (
  tx: Tx,
  ctx: WorkspaceBackfillContext,
  row: BlockData,
  names: readonly string[],
  onFailure: (blockId: string, cause: unknown) => void,
  onMaterialized: (values: number) => void,
): Promise<boolean> => {
  const lookups = {resolveNameSchema: ctx.resolveNameSchema}
  try {
    await materializePropertyChildrenForExistingRow(tx, row, lookups, names)
    onMaterialized(names.length)
    return true
  } catch {
    for (const name of names) {
      try {
        await materializePropertyChildrenForExistingRow(tx, row, lookups, [name])
        onMaterialized(1)
      } catch (cause) {
        onFailure(row.id, cause)
      }
    }
    return false
  }
}

/** One cursor-paginated walk of `candidateSql`, which must return `id` and
 *  `keys` and take (workspaceId, cursor, limit).
 *
 *  `deletesOnly` marks a leg every write of which is a deletion, so that past
 *  the flip it has nothing left it is allowed to do — see
 *  {@link namesPendingMaterialization}.
 *
 *  Reports whether any batch ran against a child-backed workspace, because the
 *  caller's convergence rule differs by mode and the flip is read per batch —
 *  down here — rather than once per run. */
const sweep = async (
  ctx: WorkspaceBackfillContext,
  candidateSql: string,
  progress: PropertyCellBackfillProgress,
  onBatch: () => void | Promise<void>,
  {deletesOnly}: {deletesOnly: boolean},
): Promise<{sawChildBacked: boolean}> => {
  let sawChildBacked = false
  const recordFailure = (blockId: string, cause: unknown) => {
    progress.failureCount += 1
    if (progress.failures.length < MAX_REPORTED_FAILURES) {
      progress.failures.push({
        blockId,
        reason: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  let cursor = ''
  let queued: {id: string; keys: number}[] = []
  for (;;) {
    if (queued.length === 0) {
      queued = await ctx.getAll<{id: string; keys: number}>(
        candidateSql, [ctx.workspaceId, cursor, SCAN_PAGE],
      )
      if (queued.length === 0) return {sawChildBacked}
      cursor = queued[queued.length - 1]!.id
    }

    // Take as many blocks as the insert budget allows, and always at least
    // one: a block heavier than the entire budget would otherwise admit
    // nothing, and the drain loop would spin forever committing empty
    // transactions rather than merely skipping it.
    const batch: {id: string}[] = []
    let budget = 0
    while (queued.length > 0 && (batch.length === 0
           || budget + queued[0]!.keys * ROWS_PER_KEY <= TARGET_INSERT_ROWS)) {
      const next = queued.shift()!
      batch.push(next)
      budget += next.keys * ROWS_PER_KEY
    }

    const abandoned = await ctx.tx(async tx => {
      // Read INSIDE the transaction that writes, per batch, because the flip
      // is a synced column: it can arrive from another device mid-run, and a
      // check taken before the run would not see it.
      const childBacked = await tx.isPropertyChildBackedWorkspace(ctx.workspaceId)
      if (childBacked) sawChildBacked = true
      if (childBacked && deletesOnly) return true
      for (const {id} of batch) {
        progress.blocksScanned += 1
        // Re-read INSIDE the transaction rather than carrying the scan's
        // snapshot into it. The scan ran before the write lock, and a pass
        // over a whole workspace spans minutes — a sync arrival draining into
        // `blocks`, or the user's own edit, lands in that window, and
        // materializing from the stale bag would write children for values
        // that are no longer there.
        const row = await tx.get(id)
        if (row === null || row.deleted) continue
        const names = childBacked
          ? await namesPendingMaterialization(tx, ctx, row)
          : await namesToReconcile(tx, ctx, row)
        const ok = await materializeRow(tx, ctx, row, names, recordFailure,
          values => {
            progress.valuesMaterialized += values
            progress.valuesMaterializedTotal += values
          })
        if (ok) progress.blocksMaterialized += 1
      }
      return false
    }, {description: 'Migrate properties to child blocks'})
    // COST, not correctness: every later batch would abandon too, so continuing
    // just pages the workspace committing empty transactions. Fails no test.
    if (abandoned) return {sawChildBacked}

    // Awaited so a caller can do real work between batches — the seam a test
    // uses to land a concurrent edit at a known point.
    await onBatch()
  }
}

/**
 * Sweep until a sweep changes nothing.
 *
 * One sweep is not enough, and the reason is not exotic: the cursor only moves
 * forward, so a property written to an already-visited block while the pass is
 * between batches is never revisited — and completion is recorded once per
 * graph, so "never" means never. The live cell → children processor cannot
 * cover for it either, being dormant until the workspace flips.
 *
 * Convergence is measured on the workspace's property-child rows rather than
 * on anything the sweep reports about itself, so it cannot be fooled by a
 * sweep that thinks it succeeded. Every sweep re-reads every property-carrying
 * block, so a sweep repairs whatever changed during the one before it; the
 * signal only decides whether another is owed.
 *
 * PRE-FLIP ONLY, and NOT closable here: a property written after the last
 * sweep reaches the flip with no children, because nothing local makes the final
 * scan and the flip atomic against a live user. Flipping FIRST is what closes it
 * (see the module header); the flip's own materialize catch-up (issue #389) is
 * the equivalent cover for a pre-flip run.
 */
export const runPropertyCellBackfill = async (
  ctx: WorkspaceBackfillContext,
  onProgress?: (progress: PropertyCellBackfillProgress) => void | Promise<void>,
): Promise<PropertyCellBackfillProgress> => {
  const progress: PropertyCellBackfillProgress = {
    blocksScanned: 0, blocksMaterialized: 0, valuesMaterialized: 0,
    valuesMaterializedTotal: 0, sweeps: 0,
    orphanedOwnersSwept: 0, failures: [], failureCount: 0, editedUnderPass: false,
  }

  const childState = async (): Promise<{n: number; t: number}> => {
    const rows = await ctx.getAll<{n: number; t: number}>(CHILD_STATE_SQL, [ctx.workspaceId])
    return {n: rows[0]?.n ?? 0, t: rows[0]?.t ?? 0}
  }

  for (;;) {
    const before = await childState()
    progress.sweeps += 1
    progress.blocksScanned = 0
    progress.blocksMaterialized = 0
    progress.valuesMaterialized = 0
    progress.failures = []
    progress.failureCount = 0
    const notify = async () => { await onProgress?.(progress) }
    const {sawChildBacked} = await sweep(
      ctx, CANDIDATE_SQL, progress, notify, {deletesOnly: false})
    const beforeOrphans = progress.blocksScanned
    await sweep(ctx, ORPHANED_OWNER_SQL, progress, notify, {deletesOnly: true})
    progress.orphanedOwnersSwept += progress.blocksScanned - beforeOrphans
    if (sawChildBacked) {
      // Past the flip the pending set only SHRINKS: every live write puts the
      // cell and its children in one transaction, so nothing BECOMES pending and
      // a sweep that materialized nothing has nothing left to find. The row count
      // is not a signal this pass owns there — the live maintainers move it too,
      // so a block gaining a property while the pass ran read as "not converged",
      // and four sweeps of ordinary editing ended the run with a give-up on a
      // workspace that was already complete. `editedUnderPass` stays false for
      // the same reason: create-only rewrites nothing.
      if (progress.valuesMaterialized === 0) {
        await onProgress?.(progress)
        break
      }
    } else {
      const after = await childState()
      if (after.n === before.n) {
        // Structurally converged. The timestamp is not part of that decision —
        // looping on it never terminates against a live editor — but if it moved
        // during the sweep that converged, this sweep was still rewriting value
        // children from cells that were changing under it.
        progress.editedUnderPass = after.t !== before.t
        // One last notification, AFTER the flag is set. Everything a subscriber
        // knows arrives through `onProgress`, which otherwise fires only from
        // inside a batch — so the palette, which is the surface an operator
        // actually uses, saw every count from the converging sweep except the
        // one thing it is supposed to act on.
        await onProgress?.(progress)
        break
      }
    }
    if (progress.sweeps >= MAX_SWEEPS) {
      throw new Error(
        `[${PROPERTY_CELL_BACKFILL_ID}] gave up after ${MAX_SWEEPS} sweeps: the workspace's ` +
        'property children kept changing, which means it is being edited faster than the ' +
        'pass runs. Nothing is lost — run it again when the workspace is idle. ' +
        'Completion was NOT recorded.',
      )
    }
  }

  return progress
}

/** The last run's outcome, for the operator surface. The `WorkspaceBackfill`
 *  seam returns nothing — an unattended pass has no one to tell — so the
 *  detail a human needs (what could not be migrated) is parked here for the
 *  caller that asked for the run to pick it up.
 *
 *  Keyed by workspace, and taken only by a caller naming the same one: a
 *  module global that any caller could take handed a later, unrelated request
 *  the previous migration's counts, so `run-backfill no-such-pass` came back
 *  decorated with someone else's scan. */
let lastRun: {workspaceId: string; progress: PropertyCellBackfillProgress} | null = null

export const takeLastPropertyCellBackfillRun = (
  workspaceId: string,
): PropertyCellBackfillProgress | null => {
  if (lastRun?.workspaceId !== workspaceId) return null
  const {progress} = lastRun
  lastRun = null
  return progress
}

export const propertyCellBackfill: WorkspaceBackfill = {
  id: PROPERTY_CELL_BACKFILL_ID,
  trigger: 'operator',
  run: async ctx => {
    lastRun = null
    // Parked in a `finally`: the run an operator most needs the failure list
    // for is the one that THREW — the give-up above, or the every-block-failed
    // floor — and the CLI has no progress listener, so this is its only
    // channel. `progress` is the same object throughout, so it carries the
    // last sweep's counts either way.
    const progress: PropertyCellBackfillProgress = {
      blocksScanned: 0, blocksMaterialized: 0, valuesMaterialized: 0,
      valuesMaterializedTotal: 0, sweeps: 0,
      orphanedOwnersSwept: 0, failures: [], failureCount: 0, editedUnderPass: false,
    }
    try {
      Object.assign(progress, await runPropertyCellBackfill(ctx, p => {
        Object.assign(progress, p)
        console.info(
          `[${PROPERTY_CELL_BACKFILL_ID}] sweep ${p.sweeps}: ` +
          `${p.blocksMaterialized}/${p.blocksScanned} blocks`,
        )
        progressListeners.notify(p)
      }))
    } finally {
      lastRun = {workspaceId: ctx.workspaceId, progress}
    }
    if (progress.failureCount > 0) {
      console.warn(
        `[${PROPERTY_CELL_BACKFILL_ID}] ${progress.failureCount} property value(s) could ` +
        `not be migrated and kept their cell value:`, progress.failures,
      )
    }
  },
}
