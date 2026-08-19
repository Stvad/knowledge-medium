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
 * Blocks that still owe child rows, oldest id first.
 *
 * The predicate is deliberately an OVER-approximation — "has more property
 * keys than field-form children" — because whether a key is REGISTERED is a
 * question only the JS registry can answer, and re-asking it in SQL would be
 * a second copy of the resolver that could disagree with the one doing the
 * work. `materializePropertyChildrenForExistingRow` is the exact test; this
 * only has to avoid missing rows.
 *
 * The cost of over-approximating is bounded and visible: a block carrying an
 * unregistered key (`pnpm agent audit-properties` lists them) stays a
 * candidate forever and is re-read on every run without ever being written.
 * The cost of UNDER-approximating would be a silently unmigrated block, so
 * the asymmetry is the right way round.
 *
 * `id > ?` paginates rather than `OFFSET`, which would re-walk the prefix per
 * batch. The pass's own creates (field and value rows) carry no properties, so
 * they never re-enter this result and the scan cannot feed itself.
 */
const CANDIDATE_SQL = `
  SELECT b.id AS id
    FROM blocks b
   WHERE b.workspace_id = ?
     AND b.deleted = 0
     AND b.id > ?
     AND json_valid(b.properties_json)
     AND json_type(b.properties_json) = 'object'
     AND (SELECT COUNT(*) FROM json_each(b.properties_json)) >
         (SELECT COUNT(*) FROM blocks c
           WHERE c.parent_id = b.id
             AND c.workspace_id = b.workspace_id
             AND c.deleted = 0
             AND c.is_field_form = 1)
   ORDER BY b.id
   LIMIT ?`

export interface PropertyCellBackfillProgress {
  blocksScanned: number
  blocksMaterialized: number
  /** Blocks whose cell value could not be materialized, with the reason.
   *  Reported, never fatal — see the catch below. */
  failures: {blockId: string; reason: string}[]
}

/** Cap on retained failure detail. The count in `blocksScanned` stays exact;
 *  this only bounds what a pathological graph can accumulate in memory and
 *  dump into a log line. */
const MAX_REPORTED_FAILURES = 50

export const runPropertyCellBackfill = async (
  ctx: WorkspaceBackfillContext,
  onProgress?: (progress: PropertyCellBackfillProgress) => void,
): Promise<PropertyCellBackfillProgress> => {
  const progress: PropertyCellBackfillProgress = {
    blocksScanned: 0, blocksMaterialized: 0, failures: [],
  }
  let failureCount = 0
  let cursor = ''

  for (;;) {
    const candidates = await ctx.getAll<{id: string}>(
      CANDIDATE_SQL, [ctx.workspaceId, cursor, PROPERTY_CELL_BACKFILL_BATCH],
    )
    if (candidates.length === 0) break
    cursor = candidates[candidates.length - 1]!.id

    await ctx.tx(async tx => {
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
          // repairs it.
          failureCount += 1
          if (progress.failures.length < MAX_REPORTED_FAILURES) {
            progress.failures.push({
              blockId: id,
              reason: cause instanceof Error ? cause.message : String(cause),
            })
          }
        }
      }
    }, {description: 'Migrate properties to child blocks'})

    onProgress?.(progress)
  }

  if (failureCount > progress.failures.length) {
    progress.failures.push({
      blockId: '(truncated)',
      reason: `${failureCount - progress.failures.length} further blocks failed; ` +
        `only the first ${MAX_REPORTED_FAILURES} are listed.`,
    })
  }
  return progress
}

export const propertyCellBackfill: WorkspaceBackfill = {
  id: PROPERTY_CELL_BACKFILL_ID,
  trigger: 'operator',
  run: async ctx => {
    const progress = await runPropertyCellBackfill(ctx, p => {
      console.info(
        `[${PROPERTY_CELL_BACKFILL_ID}] ${p.blocksMaterialized}/${p.blocksScanned} blocks`,
      )
    })
    if (progress.failures.length > 0) {
      console.warn(
        `[${PROPERTY_CELL_BACKFILL_ID}] ${progress.failures.length} block(s) could not ` +
        `be migrated and kept cell-only values:`, progress.failures,
      )
    }
  },
}
