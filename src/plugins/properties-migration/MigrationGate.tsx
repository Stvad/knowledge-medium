/**
 * App-root mount that blocks the workspace for as long as the properties
 * migration holds its claim — on EVERY device, not just the one running it.
 *
 * Driven by the claim block, which is synced data. That is what makes this
 * reach a peer at all, and it is also what makes it survive a reload: there is
 * no session state to re-arm, so a tab opened midway through the run reads the
 * claim it already has and puts the dialog straight back up.
 *
 * Two things happen while the claim is held, and they are a pair:
 *  - {@link MigrationGateDialog} says to wait, and offers the only way out of a
 *    claim nobody will release;
 *  - a history drop refuses undo/redo for the duration. The dialog cannot cover
 *    cmd-Z (see the dialog's own header), and a replay restores a whole
 *    pre-migration row over children the pass has already written.
 *
 * Ending the drop clears this device's stacks, which is the point on a PEER:
 * its pre-migration entries describe rows the migration has since rewritten,
 * and until now only the device that ran the pass dropped its own (#684, #1007).
 */
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useRepo } from '@/context/repo.js'
import { useActiveWorkspaceId } from '@/hooks/useWorkspaces.js'
import { useHandle } from '@/hooks/block.js'
import type { Repo } from '@/data/repo'
import {
  claimHoldingGraph,
  graphBackfillClaimBlockId,
  releaseStrandedGraphBackfillClaim,
  type GraphBackfillClaim,
} from '@/data/internals/graphBackfillClaim'
import { PROPERTY_CELL_BACKFILL_ID } from '@/data/internals/propertyCellBackfill'
import {
  getLocalMigrationMessage,
  subscribeLocalMigrationMessage,
} from './localRunMessage.ts'
import { MigrationGateDialog, type ReleaseOutcome } from './MigrationGateDialog.tsx'

const WorkspaceMigrationGate = ({workspaceId}: {workspaceId: string}): ReactNode => {
  const repo = useRepo()
  const claimBlock = useMemo(
    () => repo.block(graphBackfillClaimBlockId(workspaceId, PROPERTY_CELL_BACKFILL_ID)),
    [repo, workspaceId],
  )
  // Selected down to the claim, not the row: this re-renders on the claim
  // APPEARING and CLEARING, and on nothing else the block happens to carry.
  const claim = useHandle(claimBlock, {
    selector: row => claimHoldingGraph(row, workspaceId),
  })
  const localMessage = useSyncExternalStore(
    subscribeLocalMigrationMessage, getLocalMigrationMessage, getLocalMigrationMessage,
  )
  const held = claim !== null

  useEffect(() => {
    if (!held) return
    const drop = repo.undoManagerFor(workspaceId).beginHistoryDrop()
    // FINISH, never abandon, on every teardown — including a workspace switch
    // while the pass is still running. A drop left open refuses replays until
    // the page reloads, and the two endings differ only in whether this
    // device's history survives; keeping history that describes pre-migration
    // rows is the side that loses a row.
    return () => { drop.finish() }
  }, [repo, workspaceId, held])

  if (claim === null) return null
  return (
    <MigrationGateDialog
      claim={claim}
      localMessage={localMessage}
      release={releaseFor(repo, workspaceId)}
    />
  )
}

const releaseFor = (repo: Repo, workspaceId: string) =>
  (shown: GraphBackfillClaim): Promise<ReleaseOutcome> =>
    releaseStrandedGraphBackfillClaim(repo, workspaceId, PROPERTY_CELL_BACKFILL_ID, shown)

export const MigrationGate = (): ReactNode => {
  const workspaceId = useActiveWorkspaceId()
  // Keyed, so a workspace switch remounts rather than carrying the previous
  // workspace's dialog state across — including a half-answered release.
  return workspaceId === null
    ? null
    : <WorkspaceMigrationGate key={workspaceId} workspaceId={workspaceId} />
}
