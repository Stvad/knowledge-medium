/**
 * The properties-as-blocks cell → children pass (§11 slice C).
 *
 * Every block whose `properties_json` holds a registered key gets the field
 * and value CHILD rows that key implies, built by the same helper the live
 * dual-write uses (`materializePropertyChildrenForExistingRow`). Cells are
 * left exactly as they are: this pass ADDS the child representation.
 *
 * IT RUNS ONLY PAST THE FLIP, and is CREATE-ONLY (see
 * {@link namesPendingMaterialization}): the live maintainers are on and the
 * children are the property truth, so the only work left is GAPS — a cell key
 * with no field row of its own. The runbook is flip THEN backfill: flipping a
 * workspace with no children hides nothing, because at `'children'` the cell is
 * still dual-written and still the synchronous read surface, while backfilling
 * first leaves a window in which new machinery is unrecognized and visible.
 *
 * So every batch that WRITES re-asserts the flip and REFUSES an un-flipped
 * workspace (see {@link sweep}), instead of carrying a second mode for the order
 * that is no longer run. A run that finds no candidate block opens no
 * transaction and so never asks — and writes nothing either, which is the
 * property the check exists for.
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
 *  because the pass's scan and the operator's pre-run count must select the
 *  same blocks — the number a user is shown is the number the pass will read.
 *
 *  `properties_json <> '{}'` is the term that makes it servable by
 *  `idx_blocks_workspace_nonempty_properties` — see that index's comment in
 *  `blockSchema.ts` for why SQLite needs it spelled out. The trailing EXISTS is
 *  not redundant with it: a bag that is textually different from `{}` can still
 *  hold no keys, and visiting it costs a read for nothing. */
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
  /** Property values materialized this sweep, counting the ones on a block that
   *  also had a failure. */
  valuesMaterialized: number
  /** The same, for the WHOLE run. This is the one that distinguishes a
   *  systematic failure from a handful of bad values, and the per-sweep count
   *  cannot: the converging sweep is BY DEFINITION the one that found nothing
   *  left pending, so its zero is the normal ending. Testing the
   *  per-sweep count reported a run that migrated everything as "nothing was
   *  migrated — that is a systematic problem", and suppressed the repair
   *  worklist naming the values that actually failed. */
  valuesMaterializedTotal: number
  /** Full passes over the workspace. More than two means cell keys kept
   *  arriving under the pass. */
  sweeps: number
  /** Property values that could not be materialized this sweep, with the
   *  reason. Reported, never fatal — see {@link materializeRow}. Capped at
   *  {@link MAX_REPORTED_FAILURES}. */
  failures: {blockId: string; reason: string}[]
  /** Failures this sweep, including any past the cap. Paired with
   *  `blocksMaterialized === 0` it is the signal that the run hit something
   *  SYSTEMATIC — a codec rejecting everything, storage refusing writes —
   *  rather than a handful of bad values, and the operator must be told that
   *  rather than shown "migrated 0 blocks" in green. Deliberately not a throw:
   *  `blocksMaterialized` counts blocks accepted IN FULL, so one junk key on
   *  every block would abort a migration that in fact wrote most of it. */
  failureCount: number
}

/** A run's counters at zero. Two callers build one — the pass, and the
 *  `WorkspaceBackfill` wrapper that parks the last run for the operator surface
 *  — and a field added to the type must reach both. */
const emptyProgress = (): PropertyCellBackfillProgress => ({
  blocksScanned: 0, blocksMaterialized: 0, valuesMaterialized: 0,
  valuesMaterializedTotal: 0, sweeps: 0, failures: [], failureCount: 0,
})

/** Cap on retained failure detail. `failureCount` stays exact; this only
 *  bounds what a pathological graph can accumulate in memory and hand back. */
const MAX_REPORTED_FAILURES = 50

/** Sweeps before giving up. A second sweep is normal — it is what proves the
 *  first one converged. Needing a fifth means the workspace is being edited
 *  faster than the pass runs, and the right answer is to stop and say so
 *  rather than to loop against a live user. */
const MAX_SWEEPS = 4

/** The fieldIds this owner already has LIVE field rows for. Same
 *  `tx.childrenOf` the materializer reads, so "already materialized" cannot
 *  disagree with the branch it will actually take. */
const materializedFieldIds = async (tx: Tx, row: BlockData): Promise<Set<string>> => {
  const ids = new Set<string>()
  for (const child of await tx.childrenOf(row.id, undefined)) {
    const fieldId = child.isFieldForm ? getPropertyFieldTargetId(child) : undefined
    if (fieldId !== undefined) ids.add(fieldId)
  }
  return ids
}

/**
 * The create-only subset — the whole of what this pass does: cell keys with no
 * field row of their own.
 *
 * The CHILDREN are the property truth and the cell is a local, derived read
 * surface — a device that has received value rows from sync and not yet
 * re-projected them holds a stale bag over live children — so writing from the
 * cell against an existing field row overwrites real values, and naming a key
 * only the children carry tombstones them. A key with NO field row is the one
 * shape the cell is still authoritative for (§5's pending-materialization
 * rule), and it is exactly the branch
 * `materializePropertyChildrenForExistingRow` CREATES rather than reconciles:
 * filtering to it means the pass can only take that branch.
 *
 * A field row with NO value children is deliberately not treated as a gap:
 * that projects as "key unset" (§9), which is what deleting the value row
 * means, and re-adding it from the cell would undo the user's edit.
 *
 * A TOMBSTONED field row gets the same treatment. "No live field row" has two
 * causes — history, and a property DELETED through its children on a peer whose
 * owner row has not reached this device — and only the tombstone tells them
 * apart. Without it the pass recreates the property and UPLOADS it, undoing the
 * delete for the fleet. Genuine history carries no tombstone, so this costs the
 * intended path nothing. It does NOT cover an out-of-band HARD delete of a
 * child, which leaves no tombstone to find and whose stale cell key is a known
 * permanent orphan (issue #404).
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
  const reaped = new Set((await tx.tombstonedPropertyFieldRows(row.workspaceId, row.id))
    .map(getPropertyFieldTargetId))
  return Object.keys(row.properties).filter(name => {
    const fieldId = ctx.resolveNameSchema(name)?.fieldId
    // An unregistered key has no definition to point a field row AT, so the
    // materializer skips it and it can never leave this set. Excluded rather
    // than carried: convergence is "a sweep that materialized nothing", and
    // `materializeRow` counts NAMES HANDED to the materializer, so one such key
    // on one block kept every sweep looking like work and the run ended in a
    // give-up — on exactly the graphs `audit-properties` exists to find.
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
 * graph, and caught per ROW it strands every name after the bad one — so one
 * junk key leaves every other key on that block cell-only, silently, on a
 * workspace that is already reading children.
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

/** One cursor-paginated walk of {@link CANDIDATE_SQL}. */
const sweep = async (
  ctx: WorkspaceBackfillContext,
  progress: PropertyCellBackfillProgress,
  onBatch: () => void | Promise<void>,
): Promise<void> => {
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
        CANDIDATE_SQL, [ctx.workspaceId, cursor, SCAN_PAGE],
      )
      if (queued.length === 0) return
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

    await ctx.tx(async tx => {
      // Re-asserted INSIDE the transaction that writes, per batch: this pass
      // runs for minutes, so a check taken once before it started would be a
      // check at scheduling time. An un-flipped workspace is the ONE state its
      // writes are not safe in — the projection processor is dormant there, so
      // children it built would be maintained by nothing and, if a user edited
      // one, vouched for by nothing. Both operator surfaces already refuse; this
      // is what makes the refusal the pass's own rather than its callers'.
      if (!await tx.isPropertyChildBackedWorkspace(ctx.workspaceId)) {
        throw new Error(
          `[${PROPERTY_CELL_BACKFILL_ID}] refused: this device does not read workspace ` +
          `${ctx.workspaceId} as switched to property blocks. The runbook is flip THEN ` +
          'backfill — run the "Migrate properties to child blocks" command, which does ' +
          'both in order.',
        )
      }
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
        const names = await namesPendingMaterialization(tx, ctx, row)
        const ok = await materializeRow(tx, ctx, row, names, recordFailure,
          values => {
            progress.valuesMaterialized += values
            progress.valuesMaterializedTotal += values
          })
        if (ok) progress.blocksMaterialized += 1
      }
    }, {description: 'Migrate properties to child blocks'})

    // Awaited so a caller can do real work between batches — the seam a test
    // uses to land a concurrent edit at a known point.
    await onBatch()
  }
}

/**
 * Sweep until a sweep materializes nothing.
 *
 * One sweep is not enough, and the reason is not exotic: the cursor only moves
 * forward, so a cell key that appears on an already-visited block while the
 * pass is between batches is never revisited — and completion is recorded once
 * per graph, so "never" means never. A live edit cannot produce one (it writes
 * cell and children in the same transaction), but a sync arrival can: the
 * owner's bag lands here before the value rows it names.
 *
 * Convergence is "a sweep that materialized nothing", and deliberately NOT the
 * workspace's property-child row count: the live maintainers move that too, so
 * a block gaining a property while the pass ran read as "not converged", and
 * four sweeps of ordinary editing ended the run with a give-up on a workspace
 * that was already complete. The pending set only SHRINKS, so a sweep that
 * found nothing pending has nothing left to find.
 */
export const runPropertyCellBackfill = async (
  ctx: WorkspaceBackfillContext,
  onProgress?: (progress: PropertyCellBackfillProgress) => void | Promise<void>,
): Promise<PropertyCellBackfillProgress> => {
  const progress = emptyProgress()

  for (;;) {
    progress.sweeps += 1
    progress.blocksScanned = 0
    progress.blocksMaterialized = 0
    progress.valuesMaterialized = 0
    progress.failures = []
    progress.failureCount = 0
    await sweep(ctx, progress, async () => { await onProgress?.(progress) })
    if (progress.valuesMaterialized === 0) {
      // One last notification: everything a subscriber knows arrives through
      // `onProgress`, which otherwise fires only from inside a batch — so the
      // surface an operator watches never saw the converging sweep's counts.
      await onProgress?.(progress)
      break
    }
    if (progress.sweeps >= MAX_SWEEPS) {
      throw new Error(
        `[${PROPERTY_CELL_BACKFILL_ID}] gave up after ${MAX_SWEEPS} sweeps: cell keys with ` +
        'no children kept appearing, which means the workspace is changing faster than the ' +
        'pass runs. Nothing is lost — run it again when it is idle. ' +
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
    const progress = emptyProgress()
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
