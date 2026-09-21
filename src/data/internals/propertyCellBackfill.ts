/**
 * The properties-as-blocks cell → children pass (§11 slice C).
 *
 * Every block whose `properties_json` holds a registered key gets the field and
 * value CHILD rows that key implies, from the same builders the live dual-write
 * uses — {@link plannedFieldRow} and {@link plannedValueChildRows} — so the two
 * writers cannot decide differently what a value's children are. Cells are left
 * exactly as they are: this pass ADDS the child representation.
 *
 * IT RUNS ONLY PAST THE FLIP, and is CREATE-ONLY: the live maintainers are on
 * and the children are the property truth, so the only work left is GAPS — a
 * cell key with no field row of its own. That restriction is what the batch
 * plan enforces, by skipping any key whose fieldId already has a field row
 * under its owner, LIVE OR TOMBSTONED. Both halves matter: an existing row
 * means the key is already migrated, and a tombstoned one means the property
 * was deleted through its children on a peer, so re-creating it from the stale
 * cell would undo that delete and upload it.
 *
 * The runbook is flip THEN backfill: flipping a workspace with no children
 * hides nothing, because at `'children'` the cell is still dual-written and
 * still the synchronous read surface, while backfilling first leaves a window
 * in which new machinery is unrecognized and visible.
 *
 * So every batch that WRITES re-asserts the flip and REFUSES an un-flipped
 * workspace (see {@link sweep}), instead of carrying a second mode for the order
 * that is no longer run. A run that finds no candidate block opens no
 * transaction and so never asks — and writes nothing either, which is the
 * property the check exists for.
 *
 * READ AND WRITTEN IN BULK, because the pass is read-bound: a batch asks two
 * questions for the WHOLE batch — the rows, and every field row under them —
 * plans in memory, and writes through `tx.createMany`. Asking per block is the
 * shape to keep out of here; each question added costs one round trip per block
 * visited, not per batch.
 *
 * RESUMABILITY IS DERIVED, NOT CHECKPOINTED. The candidate query asks the data
 * itself what is left to do, so a run killed halfway simply finds less work
 * next time and no progress state can go stale or disagree with the graph.
 * That is why there is no cursor to persist: the pass is a fixpoint, and the
 * already-has-a-field-row test above is what makes revisiting a block a no-op.
 */

import type { BlockData, NewBlockData, ResolvedPropertySchema } from '@/data/api'
import type { WorkspaceBackfill, WorkspaceBackfillContext } from '@/data/facets'
import { CallbackSet } from '@/utils/callbackSet'
import {
  getPropertyFieldTargetId,
  propertyCellValueRejection,
} from '@/data/propertyChildren'
import {
  plannedFieldRow,
  plannedValueChildRows,
  undecodableCellValueError,
} from './propertyChildrenProcessor'

export const PROPERTY_CELL_BACKFILL_ID = 'properties:cell-to-children'

/** What `ctx.resolveNameSchema` answers with: a schema that also knows the
 *  fieldId its field rows point at. */
type ResolvedNameSchema = ResolvedPropertySchema<unknown>

/** Rows a writing transaction aims to insert. THE transaction-size knob,
 *  counted in ROWS not blocks — a heavy-property block would multiply a
 *  block-counted batch and hold the single SQLite writer with every user
 *  write and the sync drain queued behind it. */
export const TARGET_INSERT_ROWS = 190

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
 * Blocks carrying any property, oldest id first, with the ROW count the write
 * budget is drawn against: a field row per key, plus one value row per value.
 * The only thing that makes a key multi-valued at this level is its value being
 * an array, so an array is charged N + 1 and everything else 2 — an EMPTY array
 * included, because this layer cannot see the codec and under a non-list one an
 * empty array is still one value child holding `[]`. That is the only way the
 * estimate could UNDER-count, which is the direction that matters; a genuine
 * empty list property is merely over-counted by one, and so is an array under a
 * codec that is not list-shaped.
 *
 * `json_each`'s own `type` column, never `json_type(value)` — that one PARSES
 * its argument, so it raises "malformed JSON" on the first key holding a plain
 * string.
 *
 * Deliberately NOT narrowed to "blocks that still owe children". A first
 * attempt compared key count against field-row count, which is not the
 * over-approximation it looks like: an owner with cell key A and a field row
 * for B has one of each and drops out while A is still unmigrated. Any count
 * comparison can be fooled that way, and whether a key is REGISTERED is a
 * question only the JS registry can answer — so SQL selects the superset and
 * the batch plan is the exact test. A visited row with nothing to do costs no
 * read of its own, since its batch reads it either way, and no write.
 *
 * `id > ?` paginates rather than `OFFSET`, which would re-walk the prefix per
 * batch. The pass's own creates (field and value rows) carry no properties, so
 * they never enter this result and the scan cannot feed itself.
 */
export const CANDIDATE_SQL = `
  SELECT b.id AS id,
         (SELECT SUM(1 + CASE WHEN e.type = 'array'
                              THEN MAX(1, json_array_length(e.value)) ELSE 1 END)
            FROM json_each(b.properties_json) e) AS rows
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
  /** DISTINCT blocks changed over the WHOLE run — the number an operator is
   *  shown at the end.
   *
   *  The per-sweep count cannot be it: the converging sweep is by definition
   *  the one that found nothing pending, so it materializes nothing, and the
   *  outcome read from the last notification therefore reported a migration of
   *  a hundred thousand blocks as "Migrated properties on 0 blocks."
   *
   *  Nor can the per-sweep counts be SUMMED. A key that arrives behind the
   *  cursor is picked up by a later sweep, which is the whole reason the pass
   *  is a fixpoint — and if that owner already had another key materialized
   *  earlier, summing counts it twice and the total can exceed the number of
   *  blocks in the workspace. Counted by owner id instead. */
  blocksMaterializedTotal: number
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
   *  reason. Reported, never fatal: a cell value its codec refuses is legacy
   *  junk from a raw bag write, and one such key must cost its own key rather
   *  than every key on the block. Capped at {@link MAX_REPORTED_FAILURES}. */
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
  blocksScanned: 0, blocksMaterialized: 0, blocksMaterializedTotal: 0,
  valuesMaterialized: 0,
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

/** One cursor-paginated walk of {@link CANDIDATE_SQL}. */
const sweep = async (
  ctx: WorkspaceBackfillContext,
  progress: PropertyCellBackfillProgress,
  /** Owner ids changed so far in this RUN, across sweeps — see
   *  `blocksMaterializedTotal`, whose value is this set's size. Held by the
   *  run rather than the sweep because deduplicating is the whole point. */
  changedOwners: Set<string>,
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
  let queued: {id: string; rows: number}[] = []
  for (;;) {
    if (queued.length === 0) {
      queued = await ctx.getAll<{id: string; rows: number}>(
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
           || budget + queued[0]!.rows <= TARGET_INSERT_ROWS)) {
      const next = queued.shift()!
      batch.push(next)
      budget += next.rows
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
      progress.blocksScanned += batch.length
      // Re-read INSIDE the transaction rather than carrying the scan's
      // snapshot into it. The scan ran before the write lock, and a pass
      // over a whole workspace spans minutes — a sync arrival draining into
      // `blocks`, or the user's own edit, lands in that window, and
      // materializing from the stale bag would write children for values
      // that are no longer there.
      //
      // TWO reads for the whole batch, not four per block. Asking per block
      // was a third of the pass's reads on a large graph, and every one of
      // them re-asked the same two questions of a different row.
      const owners = await tx.liveRowsForIds(ctx.workspaceId, batch.map(b => b.id))
      const takenByOwner = new Map<string, Set<string>>()
      for (const fieldRow of await tx.propertyFieldRowsForParents(
        ctx.workspaceId, owners.map(owner => owner.id),
      )) {
        const fieldId = getPropertyFieldTargetId(fieldRow)
        if (fieldRow.parentId === null || fieldId === undefined) continue
        const taken = takenByOwner.get(fieldRow.parentId) ?? new Set<string>()
        taken.add(fieldId)
        takenByOwner.set(fieldRow.parentId, taken)
      }

      const planned: {
        owner: BlockData
        schema: ResolvedNameSchema
        encoded: unknown
        fieldRow: NewBlockData
      }[] = []
      for (const owner of owners) {
        let materializedHere = 0
        let rejectedHere = 0
        for (const name of Object.keys(owner.properties)) {
          const schema = ctx.resolveNameSchema(name)
          // An unregistered key has no definition to point a field row AT, so
          // it can never leave the pending set. Excluded rather than carried:
          // convergence is "a sweep that materialized nothing", and one such
          // key on one block kept every sweep looking like work.
          if (schema === undefined) continue
          if (takenByOwner.get(owner.id)?.has(schema.fieldId)) continue
          const encoded = owner.properties[name]
          // PER-NAME ISOLATION, which the row-at-a-time retry loop this
          // replaced bought by catching around one name. One key that cannot
          // be planned must cost its own key, not every key on the block and
          // not the workspace's whole pass.
          //
          // Two ways it fails, and both belong here. The cell VALUE its codec
          // refuses is the common one — legacy junk from a raw
          // `tx.update({properties})`. The other is the DEFINITION: a fieldId
          // that `propertyFieldContent` cannot render back out (whitespace,
          // parentheses) throws when the field row is built, and that is a
          // property of the definition rather than of this block's value, so
          // the value check above cannot see it coming.
          const rejection = propertyCellValueRejection(schema, encoded)
          if (rejection) {
            // The wrapper, not the bare cause: a `CodecError` says "expected
            // string, got object" and nothing about WHICH key on this block.
            recordFailure(owner.id, undecodableCellValueError(name, owner.id, schema, rejection))
            rejectedHere += 1
            continue
          }
          let fieldRow: NewBlockData
          try {
            fieldRow = plannedFieldRow(owner, schema.fieldId)
          } catch (cause) {
            recordFailure(owner.id, cause)
            rejectedHere += 1
            continue
          }
          planned.push({owner, schema, encoded, fieldRow})
          materializedHere += 1
        }
        // `blocksMaterialized` is "accepted IN FULL" — a block that kept a key
        // back is not that, and the systematic-failure signal reads this
        // paired with the failure count. The run-wide set is the other
        // question, "which blocks did this run change", and a partly migrated
        // owner did change.
        if (materializedHere > 0) {
          if (rejectedHere === 0) progress.blocksMaterialized += 1
          changedOwners.add(owner.id)
          progress.blocksMaterializedTotal = changedOwners.size
        }
        progress.valuesMaterialized += materializedHere
        progress.valuesMaterializedTotal += materializedHere
      }
      if (planned.length === 0) return

      // Field rows first, in their own call, because the value children need
      // the minted ids to point at. Both calls go through `tx.createMany`, so
      // the rows are workspace- and parent-checked and `record`ed exactly as
      // one-at-a-time creates would be.
      const fieldRowIds = await tx.createMany(planned.map(({fieldRow}) => fieldRow))
      await tx.createMany(planned.flatMap(({owner, schema, encoded}, index) =>
        plannedValueChildRows(
          {id: fieldRowIds[index]!, workspaceId: owner.workspaceId}, schema, encoded,
        )))
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
  // One entry per block this run changed, for the run-wide total. Bounded by
  // the workspace's property-carrying blocks — ~108k ids on the largest graph
  // measured, which is small beside the block snapshots the pass already holds
  // for the same run (#605).
  const changedOwners = new Set<string>()

  for (;;) {
    progress.sweeps += 1
    progress.blocksScanned = 0
    progress.blocksMaterialized = 0
    progress.valuesMaterialized = 0
    progress.failures = []
    progress.failureCount = 0
    await sweep(ctx, progress, changedOwners, async () => { await onProgress?.(progress) })
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
