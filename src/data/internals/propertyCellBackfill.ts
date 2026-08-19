/**
 * The properties-as-blocks cell → children pass (§11 slice C).
 *
 * Every block whose `properties_json` holds a registered key gets the field
 * and value CHILD rows that key implies, built by the same helper the live
 * dual-write uses (`materializePropertyChildrenForExistingRow`). Cells are
 * left exactly as they are: this pass ADDS the child representation, and the
 * workspace only starts reading it when `properties_migration` flips to
 * `'children'`. Run it BEFORE that flip — a flipped workspace whose blocks
 * have no children yet falls back to the cell (§5's pending-materialization
 * rule), but every device would then be reading a half-built tree for as long
 * as the pass takes.
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
import { materializePropertyChildrenForExistingRow } from './propertyChildrenProcessor'

export const PROPERTY_CELL_BACKFILL_ID = 'properties:cell-to-children'

/** Rows a writing transaction aims to insert. THE transaction-size knob:
 *  batching by BLOCKS let a heavy-property block multiply the real size, and
 *  at the measured ~6.5 keys per block a 100-block batch held the single
 *  SQLite writer for ~430ms — with every user write and the sync drain queued
 *  behind it, for the length of the run. The spike bisected the same budget
 *  down to 190 and this pass inherits the number. */
const TARGET_INSERT_ROWS = 190

/** A registered key costs a field row and its value row. Over-counts a key
 *  that is unregistered or already materialized, which errs toward smaller
 *  transactions. */
const ROWS_PER_KEY = 2

/** Candidates fetched per scan query. Independent of the write budget: this
 *  bounds how often the pass pays for a cursor seek, the budget bounds how
 *  long it holds the writer. */
const SCAN_PAGE = 500

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
 * `properties_json <> '{}'` is what makes this servable by
 * `idx_blocks_workspace_nonempty_properties`. The json_each EXISTS cannot be,
 * and SQLite will not infer the one from the other — without the literal term
 * the planner reads the whole workspace and sorts it into a temp B-tree once
 * per batch (92s per sweep on a 1M-row workspace, against 0.06s indexed).
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
     AND b.properties_json <> '{}'
     AND b.id > ?
     AND json_valid(b.properties_json)
     AND json_type(b.properties_json) = 'object'
     AND EXISTS (SELECT 1 FROM json_each(b.properties_json))
   ORDER BY b.id
   LIMIT ?`

/** The convergence signal: how many property-child rows the workspace has
 *  right now. It moves on a create or a delete — the structural changes, and
 *  the only ones that mean another sweep is owed.
 *
 *  Deliberately blind to UPDATES. A sweep that only rewrote the CONTENT of an
 *  existing value child has already applied that change, and asking for
 *  another sweep on the strength of it makes the pass diverge on any workspace
 *  someone is looking at: `editorSelection` and `isEditing` are registered
 *  properties on the panel block, so every caret movement rewrites one. Four
 *  caret movements across four multi-minute sweeps and the run ends
 *  unconverged, having already written every row. */
const CHILD_STATE_SQL = `
  SELECT COUNT(*) AS n
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
    `SELECT COUNT(*) AS n FROM blocks b
      WHERE b.workspace_id = ? AND b.deleted = 0
        AND b.properties_json <> '{}'
        AND json_valid(b.properties_json)
        AND json_type(b.properties_json) = 'object'
        AND EXISTS (SELECT 1 FROM json_each(b.properties_json))`,
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
   *  to zero times. */
  blocksMaterialized: number
  /** Full passes over the workspace. More than two means blocks kept changing
   *  under the pass. */
  sweeps: number
  /** Property values that could not be materialized this sweep, with the
   *  reason. Reported, never fatal — see {@link materializeRow}. Capped at
   *  {@link MAX_REPORTED_FAILURES}. */
  failures: {blockId: string; reason: string}[]
  /** Failures this sweep, including any past the cap. */
  failureCount: number
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
  for (const child of await tx.childrenOf(row.id, undefined)) {
    const fieldId = child.referenceTargetId
    if (!child.isFieldForm || !fieldId) continue
    const schema = ctx.resolveFieldSchema(fieldId)
    if (schema) names.add(schema.name)
  }
  return [...names]
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
): Promise<boolean> => {
  const lookups = {resolveNameSchema: ctx.resolveNameSchema}
  try {
    await materializePropertyChildrenForExistingRow(tx, row, lookups, names)
    return true
  } catch {
    for (const name of names) {
      try {
        await materializePropertyChildrenForExistingRow(tx, row, lookups, [name])
      } catch (cause) {
        onFailure(row.id, cause)
      }
    }
    return false
  }
}

/** One pass over every property-carrying block, cursor-paginated. */
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
    // one, so a block with more keys than the whole budget still gets a turn.
    const batch: {id: string}[] = []
    let budget = 0
    while (queued.length > 0 && (batch.length === 0
           || budget + queued[0]!.keys * ROWS_PER_KEY <= TARGET_INSERT_ROWS)) {
      const next = queued.shift()!
      batch.push(next)
      budget += next.keys * ROWS_PER_KEY
    }

    await ctx.tx(async tx => {
      // INSIDE the transaction that writes, per batch. Post-flip the children
      // are authoritative and the cell is a derived read surface, so running
      // this direction then would take a stale cell and overwrite real value
      // rows. The flip is a synced column, so it can arrive from another
      // device between batches — a check before the run would not see it.
      if (await tx.isPropertyChildBackedWorkspace(ctx.workspaceId)) {
        throw new Error(
          `[${PROPERTY_CELL_BACKFILL_ID}] aborting: workspace ${ctx.workspaceId} is ` +
          'already child-backed. This pass materializes children FROM cells, so past ' +
          'the flip it would overwrite authoritative value rows with a derived bag.',
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
        const names = await namesToReconcile(tx, ctx, row)
        if (await materializeRow(tx, ctx, row, names, recordFailure)) {
          progress.blocksMaterialized += 1
        }
      }
    }, {description: 'Migrate properties to child blocks'})

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
 * Still open by construction, and NOT closable here: a property written after
 * the last sweep but before the flip. Nothing local makes the final scan and
 * the flip atomic against a live user — the flip's own materialize catch-up is
 * what covers that window (issue #389), and re-running this pass before
 * flipping covers it in the meantime.
 */
export const runPropertyCellBackfill = async (
  ctx: WorkspaceBackfillContext,
  onProgress?: (progress: PropertyCellBackfillProgress) => void | Promise<void>,
): Promise<PropertyCellBackfillProgress> => {
  const progress: PropertyCellBackfillProgress = {
    blocksScanned: 0, blocksMaterialized: 0, sweeps: 0, failures: [], failureCount: 0,
  }

  const childState = async (): Promise<number> => {
    const rows = await ctx.getAll<{n: number}>(CHILD_STATE_SQL, [ctx.workspaceId])
    return rows[0]?.n ?? 0
  }

  for (;;) {
    const before = await childState()
    progress.sweeps += 1
    progress.blocksScanned = 0
    progress.blocksMaterialized = 0
    progress.failures = []
    progress.failureCount = 0
    await sweep(ctx, progress, async () => { await onProgress?.(progress) })
    if (await childState() === before) break
    if (progress.sweeps >= MAX_SWEEPS) {
      throw new Error(
        `[${PROPERTY_CELL_BACKFILL_ID}] gave up after ${MAX_SWEEPS} sweeps: blocks kept ` +
        'gaining property children, which means the workspace is being edited faster ' +
        'than the pass runs. Nothing is lost — run it again when the workspace is idle. ' +
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
    const progress = await runPropertyCellBackfill(ctx, p => {
      console.info(
        `[${PROPERTY_CELL_BACKFILL_ID}] sweep ${p.sweeps}: ` +
        `${p.blocksMaterialized}/${p.blocksScanned} blocks`,
      )
      progressListeners.notify(p)
    })
    lastRun = {workspaceId: ctx.workspaceId, progress}
    if (progress.failureCount > 0) {
      console.warn(
        `[${PROPERTY_CELL_BACKFILL_ID}] ${progress.failureCount} property value(s) could ` +
        `not be migrated and kept their cell value:`, progress.failures,
      )
    }
  },
}
