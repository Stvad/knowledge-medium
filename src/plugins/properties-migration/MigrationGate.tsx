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
 *  - {@link MigrationGateDialog} says to wait, and carries the way out of a
 *    claim nobody will release;
 *  - a history drop refuses undo/redo for the duration. The dialog cannot cover
 *    cmd-Z (see the dialog's own header), and a replay restores a whole
 *    pre-migration row over children the pass has already written.
 *
 * The drop is ABANDONED rather than finished — see the teardown below, which
 * says why this is not the place that can decide to empty a user's stacks.
 */
import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { ExtensionRenderBoundary } from '@/extensions/ExtensionRenderBoundary.js'
import { ChangeScope } from '@/data/api'
import { useRepo } from '@/context/repo.js'
import { getClientId } from '@/utils/clientId'
import { useActiveWorkspaceId } from '@/hooks/useWorkspaces.js'
import { useHandle } from '@/hooks/block.js'
import type { Repo } from '@/data/repo'
import {
  claimHoldingGraph,
  completedClaimFor,
  graphBackfillClaimBlockId,
  releaseStrandedGraphBackfillClaim,
  type GraphBackfillClaim,
} from '@/data/internals/graphBackfillClaim'
import { showInfo } from '@/utils/toast.js'
import { PROPERTY_CELL_BACKFILL_ID } from '@/data/internals/propertyCellBackfill'
import {
  localMigrationRunFor,
  subscribeLocalMigrationRun,
  type LocalRunSnapshot,
} from './localRunMessage.ts'
import {
  MigrationGateDialog,
  type ClaimHolder,
  type ReleaseOutcome,
} from './MigrationGateDialog.tsx'

const WorkspaceMigrationGate = ({workspaceId}: {workspaceId: string}): ReactNode => {
  const repo = useRepo()
  // Not memoized: `repo.block` is a per-id identity map, so this is already the
  // same handle every render.
  const claimBlock = repo.block(graphBackfillClaimBlockId(workspaceId, PROPERTY_CELL_BACKFILL_ID))
  // Selected down to the claim, not the row: this re-renders on the claim
  // APPEARING and CLEARING, and on nothing else the block happens to carry.
  const claim = useHandle(claimBlock, {
    selector: row => claimHoldingGraph(row, workspaceId),
  })
  const readLocal = useCallback(() => localMigrationRunFor(workspaceId), [workspaceId])
  const localRun = useSyncExternalStore(subscribeLocalMigrationRun, readLocal, readLocal)
  const readOnly = useSyncExternalStore(
    useCallback((onChange: () => void) => repo.onReadOnlyChange(onChange), [repo]),
    () => repo.isReadOnly,
  )
  // The CLAIM's duration, which is not the dialog's: the pause exists to keep a
  // replay off rows the pass has written, and the pass cannot have written
  // before it claimed.
  const held = claim !== null

  useEffect(() => {
    if (!held) return
    const manager = repo.undoManagerFor(workspaceId)
    const drop = manager.beginHistoryDrop()
    // ABANDON, never finish. The refusal is the whole job here and `abandon`
    // keeps all of it — `dropsInProgress` is decremented by either ending, so
    // replays are refused for exactly as long as the claim is held.
    //
    // What `finish` would add is EMPTYING this device's stacks, and this is not
    // the place that can decide that. The claim is taken BEFORE the first write
    // and handed back on paths that wrote nothing — a non-owner refused by the
    // flip trigger, synthesis throwing, a re-run over an already-migrated
    // workspace — and "the claim went away" cannot tell those from a pass that
    // rewrote the graph. Finishing charged every device its whole history for
    // them, repeatably, since the gesture invites a retry.
    //
    // So the clear stays with the writers that know they wrote: the gesture's
    // own drop around the flip, and the runner's per batch. A PEER therefore
    // keeps pre-migration entries a completed run has made stale — #684/#1007,
    // where a watcher was declined. A sound clear here needs the claim to
    // record that the run WROTE, stamped in the same transaction as the first
    // write; it cannot be inferred from the claim going away.
    //
    // Which is why the reload notice is a TOAST rather than a line in the
    // dialog: the dialog unmounts at exactly the moment reloading starts to
    // matter, and in a shared workspace the peer belongs to someone who never
    // sees the operator's confirmation.
    return () => {
      drop.abandon()
      // The row as it is NOW, not as it was when the drop began — the handle is
      // the same object and its cache has the ending that just fired.
      // `claimHoldingGraph` filters a completed claim out by design, so
      // liveness alone cannot tell "the pass finished" from "the claim was
      // handed back", and only the first owes the user anything.
      //
      // AND only a device that still has entries to replay. The tab that ran
      // the pass cleared its own as it committed, and telling it to reload
      // before using an undo stack it no longer has put a second infinite toast
      // on screen contradicting its own outcome ("Undo history was cleared").
      // Asking the stack is truer than asking who the claimant was: a sibling
      // tab of the same profile kept its entries and does need this.
      if (completedClaimFor(claimBlock.peek(), workspaceId) !== null
          && manager.depths(ChangeScope.BlockDefault).undo > 0) {
        showReloadNotice()
      }
    }
  }, [repo, workspaceId, held, claimBlock])

  const holder = holderOf(claim, localRun)
  if (holder === null) return null
  return (
    // The dialog gets its OWN boundary, below the effect above. It reaches the
    // shortcut activation funnel, which suspends on the workspace's UI-state
    // block and throws if that read fails — and app mounts share one boundary
    // per mount, so without this a dialog that cannot render takes the undo
    // pause down with it: the effect above never commits, and the run proceeds
    // with no modal, no pause and nothing on screen to say so. The pause is the
    // half that protects rows, so it must not be downstream of the half that
    // only talks.
    <ExtensionRenderBoundary>
      <MigrationGateDialog
        holder={holder}
        release={readOnly ? null : releaseFor(repo, workspaceId)}
      />
    </ExtensionRenderBoundary>
  )
}

/** WHO is running the pass, relative to the tab reading this.
 *
 *  One value rather than two booleans at the point of use, because the two
 *  questions the dialog asks — what to tell the user, and whether to offer the
 *  release — have to be answered from the same reading. Answering them
 *  separately is what produced a dialog that told the operator's second tab
 *  another DEVICE held the workspace, and offered the running tab itself a
 *  button to release the claim it was writing under.
 *
 *  BOTH halves for `this-tab`, not the local message alone. The gesture
 *  publishes its first line before it takes the claim, so between those two
 *  moments a PEER's claim can be what is on screen — and a message this device
 *  wrote would otherwise be reported as that peer's progress. */
const holderOf = (
  claim: GraphBackfillClaim | null, localRun: LocalRunSnapshot | null,
): ClaimHolder | null => {
  // NO CLAIM is two situations, not one, and the row cannot tell them apart —
  // it is equally absent before a run takes it and after a run loses it. Before
  // is `starting`, and covers the window between the confirmation and the claim
  // write, which holds two preflight reads and a page-ensure; without it the
  // operator confirms a one-way fleet-wide flip and the app goes quiet. AFTER
  // is a tab that was writing and is no longer protected, which must not be
  // told that nothing has been written — it is the one tab whose closing costs
  // something, and the released case reaches it from a click the dialog itself
  // offers.
  if (claim === null) {
    if (localRun === null) return null
    return localRun.claimed
      ? {kind: 'lost-claim', message: localRun.message}
      : {kind: 'starting', message: localRun.message}
  }
  if (claim.claimantId !== getClientId()) return {kind: 'another-device', claim}
  return localRun === null
    ? {kind: 'this-browser', claim}
    : {kind: 'this-tab', message: localRun.message, claim}
}

/** What is left on screen after the dialog goes. Sticky, because the user it is
 *  for is a PEER — whose own device kept undo entries the run has made stale,
 *  and who may have walked away for the several minutes the run took. */
const showReloadNotice = (): void => {
  showInfo(
    'This workspace finished migrating. Reload this tab before using undo: entries from '
    + 'before the migration can revert part of it.',
    {id: 'properties-migration-reload', duration: Number.POSITIVE_INFINITY},
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
