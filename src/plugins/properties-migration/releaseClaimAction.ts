/**
 * The way out of the migration lock.
 *
 * While the cell-to-children pass holds a workspace's claim, the graph refuses
 * writes — and the claim block is itself a block, so the delete that used to be
 * the documented recovery for a claimant that died mid-pass is refused along
 * with everything else. Without this command a dead claimant locks the graph
 * from inside the app with no way out.
 *
 * Two steps on purpose. Nothing can tell a dead claimant from a live one, so
 * the command REPORTS what it found and the user confirms; releasing a claim a
 * device is still running under frees a second device to start the same
 * uploading pass over the same rows.
 */
import { Unlock } from 'lucide-react'
import type { Repo } from '@/data/repo'
import { PROPERTY_CELL_BACKFILL_ID } from '@/data/internals/propertyCellBackfill'
import {
  graphBackfillClaimBlockId,
  readGraphBackfillClaim,
  releaseStrandedGraphBackfillClaim,
  RELEASE_STRANDED_CLAIM_COMMAND,
} from '@/data/internals/graphBackfillClaim'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.js'
import { showInfo } from '@/utils/toast.js'

const TOAST = {id: 'properties-migration-release-claim', duration: Number.POSITIVE_INFINITY}

const NOTHING_HELD =
  'No properties migration is holding this workspace. Its writes are not being '
  + 'blocked by a claim, so there is nothing to release.'

/** Whole hours, then whole minutes: the operator is deciding whether a pass
 *  could still be running, and an exact duration says nothing they can use. */
const heldFor = (claimedAt: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - claimedAt) / 60_000))
  if (minutes < 60) return `${minutes} minute(s)`
  return `${Math.round(minutes / 60)} hour(s)`
}

export const releaseMigrationClaimAction = ({repo}: {repo: Repo}): ActionConfig => ({
  id: 'release_properties_migration_claim',
  description: RELEASE_STRANDED_CLAIM_COMMAND,
  context: ActionContextTypes.GLOBAL,
  icon: Unlock,
  handler: async () => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const claim = await readGraphBackfillClaim(
      repo.db,
      graphBackfillClaimBlockId(workspaceId, PROPERTY_CELL_BACKFILL_ID),
      workspaceId,
    )
    // A COMPLETED claim is the graph's record that the migration ran, not a
    // lock — and deleting it would leave the graph reading as never-migrated.
    if (claim === null || claim.completedAt !== undefined) {
      showInfo(NOTHING_HELD, TOAST)
      return
    }
    const release = async (): Promise<void> => {
      try {
        const outcome = await releaseStrandedGraphBackfillClaim(
          repo, workspaceId, PROPERTY_CELL_BACKFILL_ID,
        )
        showInfo(
          outcome === 'released'
            ? 'Claim released. This workspace accepts edits again, and the migration can be '
              + 'run once more.'
            : NOTHING_HELD,
          TOAST,
        )
      } catch (err) {
        console.error('[properties-migration] could not release the claim:', err)
        showInfo(
          'Could not release the claim: '
          + `${err instanceof Error ? err.message : String(err)}`,
          TOAST,
        )
      }
    }

    showInfo(
      `The properties migration claimed this workspace ${heldFor(claim.claimedAt, Date.now())} `
      + 'ago and has not recorded finishing, so this workspace is not accepting edits. '
      + 'Release it only if no device is still running the migration: releasing a live '
      + 'claim lets a second device start the same pass over the same blocks.',
      {...TOAST, action: {label: 'Release it', onClick: () => { void release() }}},
    )

  },
})
