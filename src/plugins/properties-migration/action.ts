import { FolderTree } from 'lucide-react'
import type { OperatorBackfillResult, Repo } from '@/data/repo'
import {
  PROPERTY_CELL_BACKFILL_ID,
  countPropertyCellBackfillCandidates,
  onPropertyCellBackfillProgress,
} from '@/data/internals/propertyCellBackfill'
import { readIsChildBackedWorkspace } from '@/data/workspaceSchema'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.js'
import { openDialog } from '@/utils/dialogs.js'
import { showInfo, showProgress } from '@/utils/toast.js'
import { ConfirmMigrationDialog } from './ConfirmMigrationDialog.tsx'

/** What to tell the user, per outcome. `deferred` and `held-by-peer` are
 *  deliberately separate sentences: one means "retry in a moment", the other
 *  means "another device owns this run".
 *
 *  `followUp` is the part the operator has to ACT on. It is shown as its own
 *  sticky toast rather than appended here, because the banner's completion
 *  message clears in a couple of seconds and this pass runs for minutes —
 *  long enough that nobody is still watching when it lands. */
/** The runner's reasons come from several places and only some end in a
 *  period, which is how "…partially materialized graph.. Try again" happened. */
const withPeriod = (reason: string | undefined): string =>
  reason === undefined ? '' : /[.!?]$/.test(reason) ? reason : `${reason}.`

/** Appended to EVERY outcome that could have written. The pass clears the
 *  workspace's undo stack on its first committed batch, and an operator who is
 *  not told finds their history silently gone — which the `ran` branch said
 *  and the abort branches, the ones that actually strand a half-done run,
 *  did not. */
const undoNote = (result: OperatorBackfillResult): string =>
  result.undoHistoryCleared ? ' Undo history for this workspace was cleared.' : ''

export const describeOutcome = (
  result: OperatorBackfillResult,
  counts: {
    blocksMaterialized: number
    valuesMaterialized: number
    unmigrated: number
    orphanedOwnersSwept: number
  },
  editedUnderPass: boolean,
): {message: string; failed: boolean; followUp?: string} => {
  const {blocksMaterialized, valuesMaterialized, unmigrated, orphanedOwnersSwept} = counts
  switch (result.outcome) {
    case 'ran':
      // On VALUES, not on blocks. `blocksMaterialized` counts blocks accepted
      // in FULL, so one junk key on every block reads as zero for a run that
      // wrote all the other keys — and this branch would then tell the
      // operator nothing was migrated while tens of thousands of rows were.
      if (valuesMaterialized === 0 && unmigrated > 0) {
        return {
          message: `Nothing was migrated — all ${unmigrated.toLocaleString()} property ` +
            'value(s) failed. That is a systematic problem, not a handful of bad values; ' +
            'see the console before running this again.',
          failed: true,
        }
      }
      return {
        message: `Migrated properties on ${blocksMaterialized.toLocaleString()} blocks.` +
          // Deletion is the part of this pass an operator would want to check,
          // and it is otherwise reported nowhere.
          (orphanedOwnersSwept > 0
            ? ` Removed the property children of ${orphanedOwnersSwept.toLocaleString()} ` +
              'block(s) whose properties had been deleted.'
            : '') +
          (editedUnderPass
            ? ' The workspace was edited while it ran, so some values may already be behind —' +
              ' run this again.'
            : '') +
          undoNote(result),
        // Surfaced through `done`, not `fail`: the pass DID complete, and
        // saying otherwise would send an operator looking for a broken run
        // rather than for the handful of values named in the console.
        failed: false,
        followUp: unmigrated > 0
          ? `${unmigrated.toLocaleString()} property value(s) could not be migrated and kept ` +
            'their cell value — see the console for which (first 50 shown). Repair them and ' +
            'run this again.'
          : undefined,
      }
    case 'deferred':
      // "Not started" only if it really did not: the per-transaction
      // preconditions abort mid-run too, and on a connected device that is the
      // EXPECTED ending (km-gwam) — after the pass has written a large part of
      // the graph and cleared the undo history on its first committed batch.
      return {
        message: (result.undoHistoryCleared
          ? `Stopped before finishing — ${withPeriod(result.reason)} Already-migrated blocks ` +
            'are skipped, so run it again.'
          : `Not started — ${withPeriod(result.reason)} Try again shortly.`) + undoNote(result),
        failed: true,
      }
    case 'failed':
      return {
        // No blanket "run it again": true for the give-up and for an
        // unexpected throw, false for a missing claim seam, which fails
        // identically every time. Each reason carries its own.
        message: `Stopped partway — ${withPeriod(result.reason)}${undoNote(result)}`,
        failed: true,
      }
    case 'held-by-peer':
      return {
        // NOT "already migrated": an operator run reclaims a completed pass,
        // so this outcome only ever means another device holds the claim —
        // including one that took it and never came back, which no timeout
        // clears. Naming where the claim lives is the whole recovery.
        message: 'Another client holds this migration — another device, or another tab of ' +
          'this browser. Wait for it to finish; if nothing is running, check the claim ' +
          'block on the "System Migrations (km)" page and delete it to release the pass.',
        failed: true,
      }
    case 'already-running':
      return {message: 'The migration is already running on this device.', failed: false}
    case 'read-only':
      return {message: 'This workspace is read-only, so the migration cannot write.', failed: true}
    case 'not-found':
      return {message: `No migration is registered under "${PROPERTY_CELL_BACKFILL_ID}".`, failed: true}
  }
}

/**
 * Command-palette entry for the one-time properties-as-blocks migration.
 *
 * The palette is the surface on purpose: the pass is never scheduled — it
 * uploads source-of-truth rows, so ONE device runs it and the rest receive
 * them — and "open the palette and run this" is an instruction that can be
 * given to any user. The CLI verb (`kmagent run-backfill`) is the same call
 * for an operator already at a terminal.
 */
export const migratePropertiesToBlocksAction = ({repo}: {repo: Repo}): ActionConfig => ({
  id: 'migrate_properties_to_blocks',
  description: 'Migrate properties to child blocks (one-time)',
  context: ActionContextTypes.GLOBAL,
  icon: FolderTree,
  handler: async () => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    // NOT a refusal, which is what this used to be. Flip THEN backfill is the
    // runbook — the flip turns the live maintainers on and this pass fills in
    // the history they were not there for — so "already child-backed" is the
    // normal case, not a dead end. It is a materially smaller job (create-only,
    // §5's pending-materialization set), and the confirmation is where an
    // operator finds that out.
    const childBacked = await readIsChildBackedWorkspace(repo.db, workspaceId)
    const blockCount = await countPropertyCellBackfillCandidates(
      (sql, params) => repo.db.getAll(sql, params as unknown[] | undefined), workspaceId,
    )
    if (!await openDialog(ConfirmMigrationDialog, {blockCount, childBacked})) return
    // Re-read AFTER the dialog. A confirmation is a user-length pause, and the
    // workspace pinned before it may not be the open one now — the runner's
    // own active-workspace check happens only after `tryClaim` has written a
    // Migrations page and a claim row, so the wrong graph would be touched
    // before anything refused.
    if (repo.activeWorkspaceId !== workspaceId) return

    const banner = showProgress('Migrating properties to blocks…')
    let materialized = 0
    // Subscribed for the whole run, not just started with it: the pass reports
    // per committed batch, and a run of several minutes with a silent toast is
    // indistinguishable from a hung one.
    let unmigrated = 0
    let valuesMaterialized = 0
    let orphanedOwnersSwept = 0
    let editedUnderPass = false
    const unsubscribe = onPropertyCellBackfillProgress(progress => {
      materialized = progress.blocksMaterialized
      valuesMaterialized = progress.valuesMaterialized
      orphanedOwnersSwept = progress.orphanedOwnersSwept
      unmigrated = progress.failureCount
      editedUnderPass = progress.editedUnderPass
      // Counts are per-sweep, and the sweep number is shown because a second
      // pass over the same blocks is normal — without it the bar restarts from
      // zero for no reason the operator can see.
      banner.update(
        `Migrating properties to blocks… sweep ${progress.sweeps}, ` +
        `${progress.blocksScanned.toLocaleString()}/` +
        `${Math.max(blockCount, progress.blocksScanned).toLocaleString()}`,
      )
    })
    try {
      const result = await repo.runWorkspaceBackfillNow(workspaceId, PROPERTY_CELL_BACKFILL_ID)
      const {message, failed, followUp} = describeOutcome(
        result,
        {blocksMaterialized: materialized, valuesMaterialized, unmigrated, orphanedOwnersSwept},
        editedUnderPass,
      )
      if (failed) banner.fail(message)
      else banner.done(message)
      // A stable id: the follow-up tells the operator to run this again, and
      // without one the next run stacks a second sticky toast beside the
      // first, identical apart from a count that is now wrong.
      if (followUp) {
        showInfo(followUp, {id: 'properties-migration-worklist',
                            duration: Number.POSITIVE_INFINITY})
      }
    } catch (err) {
      console.error('[properties-migration] failed:', err)
      banner.fail(`Migration failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      unsubscribe()
    }
  },
})
