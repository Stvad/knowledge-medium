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

import type { WorkspaceBackfill, WorkspaceBackfillContext } from '@/data/facets'
import { CallbackSet } from '@/utils/callbackSet'
import { materializePropertyChildrenForExistingRow } from './propertyChildrenProcessor'

export const PROPERTY_CELL_BACKFILL_ID = 'properties:cell-to-children'

/** Blocks per writing transaction. Each one expands to ~2 creates per
 *  registered key on it (a field row and its value row), so this is the real
 *  transaction size knob — at the measured ~6.5 keys per block a batch of 100
 *  is on the order of a thousand inserts. Small enough that a killed run
 *  loses little, large enough that a ~55k-block workspace is a few hundred
 *  transactions rather than tens of thousands. */
export const PROPERTY_CELL_BACKFILL_BATCH = 100

/**
 * Blocks carrying any property, oldest id first.
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
const CANDIDATE_SQL = `
  SELECT b.id AS id
    FROM blocks b
   WHERE b.workspace_id = ?
     AND b.deleted = 0
     AND b.id > ?
     AND json_valid(b.properties_json)
     AND json_type(b.properties_json) = 'object'
     AND EXISTS (SELECT 1 FROM json_each(b.properties_json))
   ORDER BY b.id
   LIMIT ?`

const FIELD_ROW_COUNT_SQL = `
  SELECT COUNT(*) AS n FROM blocks
   WHERE workspace_id = ? AND deleted = 0 AND is_field_form = 1`

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

export interface PropertyCellBackfillProgress {
  /** Blocks read. Counts every sweep, so it exceeds the workspace's block
   *  count when more than one was needed. */
  blocksScanned: number
  /** Blocks the materializer accepted. Not "blocks changed" — a block that
   *  already had its children is accepted and written to zero times. */
  blocksMaterialized: number
  /** Full passes over the workspace. More than two means blocks kept changing
   *  under the pass. */
  sweeps: number
  /** Blocks whose cell value could not be materialized, with the reason.
   *  Reported, never fatal — see the catch below. */
  failures: {blockId: string; reason: string}[]
}

/** Cap on retained failure detail. `blocksScanned` stays exact; this only
 *  bounds what a pathological graph can accumulate in memory and hand back. */
const MAX_REPORTED_FAILURES = 50

/** Sweeps before giving up. A second sweep is normal — it is what proves the
 *  first one converged. Needing a fifth means the workspace is being edited
 *  faster than the pass runs, and the right answer is to stop and say so
 *  rather than to loop against a live user. */
const MAX_SWEEPS = 4

class UnconvergedError extends Error {}

/** One pass over every property-carrying block, cursor-paginated. */
const sweep = async (
  ctx: WorkspaceBackfillContext,
  progress: PropertyCellBackfillProgress,
  failureCount: {value: number},
  onBatch: () => void | Promise<void>,
): Promise<void> => {
  let cursor = ''
  for (;;) {
    const candidates = await ctx.getAll<{id: string}>(
      CANDIDATE_SQL, [ctx.workspaceId, cursor, PROPERTY_CELL_BACKFILL_BATCH],
    )
    if (candidates.length === 0) return
    cursor = candidates[candidates.length - 1]!.id

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
      for (const {id} of candidates) {
        progress.blocksScanned += 1
        // Re-read INSIDE the transaction rather than carrying the scan's
        // snapshot into it. The scan ran before the write lock, and a pass
        // over a whole workspace spans minutes — a sync arrival draining into
        // `blocks`, or the user's own edit, lands in that window, and
        // materializing from the stale bag would write children for values
        // that are no longer there.
        const row = await tx.get(id)
        if (row === null || row.deleted) continue
        try {
          await materializePropertyChildrenForExistingRow(
            tx, row, {resolveNameSchema: ctx.resolveNameSchema},
          )
          progress.blocksMaterialized += 1
        } catch (cause) {
          // A pre-existing cell value that does not decode under its schema's
          // codec — legacy junk from a raw `tx.update({properties})`. The
          // materializer REFUSES such a write, which is right for a live edit
          // and wrong for a one-time sweep: one bad value would abort the
          // migration for the whole graph. Report the block and carry on; the
          // cell keeps its value, and the key stays cell-only until someone
          // repairs it and runs the pass again.
          failureCount.value += 1
          if (progress.failures.length < MAX_REPORTED_FAILURES) {
            progress.failures.push({
              blockId: id,
              reason: cause instanceof Error ? cause.message : String(cause),
            })
          }
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
 * Convergence is measured on the workspace's field-row count rather than on
 * anything the sweep reports about itself, so it cannot be fooled by a sweep
 * that thinks it succeeded. A value-row content update does not move that
 * count, which is fine: those are idempotent, so there is nothing left to do
 * once one has happened.
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
    blocksScanned: 0, blocksMaterialized: 0, sweeps: 0, failures: [],
  }
  const failureCount = {value: 0}

  const fieldRows = async (): Promise<number> => {
    const rows = await ctx.getAll<{n: number}>(FIELD_ROW_COUNT_SQL, [ctx.workspaceId])
    return rows[0]?.n ?? 0
  }

  for (;;) {
    const before = await fieldRows()
    progress.sweeps += 1
    await sweep(ctx, progress, failureCount, async () => { await onProgress?.(progress) })
    if (await fieldRows() === before) break
    if (progress.sweeps >= MAX_SWEEPS) {
      throw new UnconvergedError(
        `[${PROPERTY_CELL_BACKFILL_ID}] gave up after ${MAX_SWEEPS} sweeps: blocks kept ` +
        'gaining property children, which means the workspace is being edited faster ' +
        'than the pass runs. Nothing is lost — run it again when the workspace is idle. ' +
        'Completion was NOT recorded.',
      )
    }
  }

  if (failureCount.value > progress.failures.length) {
    progress.failures.push({
      blockId: '(truncated)',
      reason: `${failureCount.value - progress.failures.length} further blocks failed; ` +
        `only the first ${MAX_REPORTED_FAILURES} are listed.`,
    })
  }
  return progress
}

/** The last run's outcome, for the operator surface. The `WorkspaceBackfill`
 *  seam returns nothing — an unattended pass has no one to tell — so the
 *  detail a human needs (what could not be migrated) is parked here for the
 *  caller that asked for the run to pick up. */
let lastRun: PropertyCellBackfillProgress | null = null

export const takeLastPropertyCellBackfillRun = (): PropertyCellBackfillProgress | null => {
  const run = lastRun
  lastRun = null
  return run
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
    lastRun = progress
    if (progress.failures.length > 0) {
      console.warn(
        `[${PROPERTY_CELL_BACKFILL_ID}] ${progress.failures.length} block(s) could not ` +
        `be migrated and kept cell-only values:`, progress.failures,
      )
    }
  },
}
