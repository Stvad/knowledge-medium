import { FolderTree } from 'lucide-react'
import type { OperatorBackfillResult, Repo } from '@/data/repo'
import {
  PROPERTY_CELL_BACKFILL_ID,
  countPropertyCellBackfillCandidates,
  onPropertyCellBackfillProgress,
} from '@/data/internals/propertyCellBackfill'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.js'
import { openDialog } from '@/utils/dialogs.js'
import { showProgress } from '@/utils/toast.js'
import { ConfirmMigrationDialog } from './ConfirmMigrationDialog.tsx'

/** What to tell the user, per outcome. `deferred` and `already-done-or-held`
 *  are deliberately separate sentences: one means "retry in a moment", the
 *  other means "stop asking, it is handled". */
const describeOutcome = (
  result: OperatorBackfillResult,
  blocksMaterialized: number,
  unmigrated: number,
): {message: string; failed: boolean} => {
  switch (result.outcome) {
    case 'ran':
      return {
        message: `Migrated properties on ${blocksMaterialized.toLocaleString()} blocks.` +
          (unmigrated > 0
            ? ` ${unmigrated.toLocaleString()} could not be migrated and kept cell-only ` +
              'values — see the console for which. Repair them and run this again.'
            : '') +
          (result.undoHistoryCleared ? ' Undo history for this workspace was cleared.' : ''),
        // Surfaced through `done`, not `fail`: the pass DID complete, and
        // saying otherwise would send an operator looking for a broken run
        // rather than for the handful of blocks named in the console.
        failed: false,
      }
    case 'deferred':
      return {message: `Not started — ${result.reason}. Try again shortly.`, failed: true}
    case 'failed':
      return {
        message: `Stopped partway — ${result.reason} Run it again; ` +
          'already-migrated blocks are skipped.',
        failed: true,
      }
    case 'already-done-or-held':
      return {
        message: 'Nothing to do: this workspace is already migrated, or another device is ' +
          'running the migration now.',
        failed: false,
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
    const blockCount = await countPropertyCellBackfillCandidates(
      (sql, params) => repo.db.getAll(sql, params as unknown[] | undefined), workspaceId,
    )
    if (!await openDialog(ConfirmMigrationDialog, {blockCount})) return

    const banner = showProgress('Migrating properties to blocks…')
    let materialized = 0
    // Subscribed for the whole run, not just started with it: the pass reports
    // per committed batch, and a run of several minutes with a silent toast is
    // indistinguishable from a hung one.
    let unmigrated = 0
    const unsubscribe = onPropertyCellBackfillProgress(progress => {
      materialized = progress.blocksMaterialized
      unmigrated = progress.failures.length
      banner.update(
        `Migrating properties to blocks… ${progress.blocksScanned.toLocaleString()}/` +
        `${Math.max(blockCount, progress.blocksScanned).toLocaleString()}`,
      )
    })
    try {
      const result = await repo.runWorkspaceBackfillNow(workspaceId, PROPERTY_CELL_BACKFILL_ID)
      const {message, failed} = describeOutcome(result, materialized, unmigrated)
      if (failed) banner.fail(message)
      else banner.done(message)
    } catch (err) {
      console.error('[properties-migration] failed:', err)
      banner.fail(`Migration failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      unsubscribe()
    }
  },
})
