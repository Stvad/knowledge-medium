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
const describeOutcome = (
  result: OperatorBackfillResult,
  blocksMaterialized: number,
  unmigrated: number,
): {message: string; failed: boolean; followUp?: string} => {
  switch (result.outcome) {
    case 'ran':
      return {
        message: `Migrated properties on ${blocksMaterialized.toLocaleString()} blocks.` +
          (result.undoHistoryCleared ? ' Undo history for this workspace was cleared.' : ''),
        // Surfaced through `done`, not `fail`: the pass DID complete, and
        // saying otherwise would send an operator looking for a broken run
        // rather than for the handful of values named in the console.
        failed: false,
        followUp: unmigrated > 0
          ? `${unmigrated.toLocaleString()} property value(s) could not be migrated and kept ` +
            'their cell value — see the console for which. Repair them and run this again ' +
            'before flipping the workspace.'
          : undefined,
      }
    case 'deferred':
      return {message: `Not started — ${result.reason}. Try again shortly.`, failed: true}
    case 'failed':
      return {
        message: `Stopped partway — ${result.reason} Run it again; ` +
          'already-migrated blocks are skipped.',
        failed: true,
      }
    case 'held-by-peer':
      return {
        // NOT "already migrated": an operator run reclaims a completed pass,
        // so this outcome only ever means another device holds the claim —
        // including one that took it and never came back, which no timeout
        // clears. Naming where the claim lives is the whole recovery.
        message: 'Another device holds this migration. Wait for it to finish — or, if that ' +
          'device is gone, delete the claim block on the "System Migrations (km)" page and ' +
          'run this again.',
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
    // Before the full-workspace scan and the confirmation, not inside the
    // first batch transaction. Past the flip this pass can never run, so the
    // refusal owes the operator a sentence — and letting it reach the tx
    // instead spent a workspace scan and a user-length pause to produce an
    // internal error saying it "stopped partway" and to try again.
    if (await readIsChildBackedWorkspace(repo.db, workspaceId)) {
      showInfo('This workspace already reads properties from child blocks — ' +
        'the migration has nothing left to do.')
      return
    }
    const blockCount = await countPropertyCellBackfillCandidates(
      (sql, params) => repo.db.getAll(sql, params as unknown[] | undefined), workspaceId,
    )
    if (!await openDialog(ConfirmMigrationDialog, {blockCount})) return
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
    const unsubscribe = onPropertyCellBackfillProgress(progress => {
      materialized = progress.blocksMaterialized
      unmigrated = progress.failureCount
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
      const {message, failed, followUp} = describeOutcome(result, materialized, unmigrated)
      if (failed) banner.fail(message)
      else banner.done(message)
      if (followUp) showInfo(followUp, {duration: Number.POSITIVE_INFINITY})
    } catch (err) {
      console.error('[properties-migration] failed:', err)
      banner.fail(`Migration failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      unsubscribe()
    }
  },
})
