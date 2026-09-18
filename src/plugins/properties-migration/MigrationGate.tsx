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
import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
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
  // The same row read for the OTHER ending: `claimHoldingGraph` filters a
  // completed claim out by design, so liveness alone cannot tell a pass that
  // ran to the end from a claim that was handed back.
  const completed = useHandle(claimBlock, {
    selector: row => completedClaimFor(row, workspaceId),
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

  // Set in the effect, never during render: this is the mount's own memory of
  // having seen the claim live, which is what separates "the run just finished"
  // from "this workspace was migrated at some point in the past".
  const watchedTheClaim = useRef(false)

  useEffect(() => {
    if (!held) return
    watchedTheClaim.current = true
    const drop = repo.undoManagerFor(workspaceId).beginHistoryDrop()
    // ABANDON, never finish. The refusal is the whole job here and `abandon`
    // keeps all of it — `dropsInProgress` is decremented by either ending, so
    // replays are refused for exactly as long as the claim is held.
    //
    // What `finish` would add is EMPTYING this device's stacks, and this is not
    // the place that can decide that. The claim is taken BEFORE the first write
    // and handed back on paths that wrote nothing — a re-run over an
    // already-migrated workspace, say — and "the claim went away" cannot tell
    // those from a pass that rewrote the graph.
    //
    // So the clear stays with the writers that know they wrote: the gesture's
    // own drop around the flip, and the runner's per batch. A PEER therefore
    // keeps pre-migration entries a completed run has made stale — #684/#1007.
    return () => { drop.abandon() }
  }, [repo, workspaceId, held])

  // Driven by the COMPLETION, and gated on this mount having WATCHED the claim.
  //
  // The completion is not an event: `markComplete` stamps `completedAt` and that
  // row is never deleted, because it IS the graph's record that the migration
  // ran. So "completed" is a permanent property of the workspace, and an effect
  // keyed on it alone fires on every mount for the rest of the workspace's life
  // — over post-migration edits it warns about for no reason, which is how the
  // one notice that matters gets trained away.
  //
  // Not the drop's teardown either, which is what this replaced: that fires only
  // on the way out of `held`, and a completion can arrive after it — a release
  // whose `markComplete` restores the row it tombstoned, a workspace switch, a
  // reload mid-run. Those left the notice silent for exactly the device whose
  // entries had just been invalidated.
  //
  // `completedAt` says the pass RAN TO THE END, not that it WROTE (km-5ccs). The
  // depth check covers most of that gap — a device with nothing on its stack has
  // nothing to be warned about, and the tab that ran the pass cleared its own as
  // it committed. What it still gets wrong is a re-run that commits nothing.
  //
  // WHAT THE `watchedTheClaim` GATE GIVES UP: a device that was offline for the
  // whole run and receives only the completed row is told nothing, and its
  // entries are genuinely stale. That enlarges the accepted offline residual,
  // and is the trade against warning every user on every workspace forever.
  //
  // Why a toast, and why sticky: see `showReloadNotice`.
  const completedAt = completed?.completedAt ?? null
  useEffect(() => {
    if (completedAt === null || !watchedTheClaim.current) return
    if (repo.undoManagerFor(workspaceId).depths(ChangeScope.BlockDefault).undo === 0) return
    showReloadNotice()
  }, [repo, workspaceId, completedAt])

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
 *  release — have to be answered from the same reading.
 *
 *  TWO INDEPENDENT INPUTS, and the claim row answers only one of them. It says
 *  whose browser profile holds the migration; it cannot say whether THIS tab is
 *  the one running it, because a claimant id is a profile and every tab of that
 *  profile shares it. `localRun.claimed` is the other half and the run is the
 *  only thing that knows it.
 *
 *  Reading the claim FIRST is what makes a tab that has lost its claim
 *  unreachable: released mid-write — which is a click this dialog itself offers
 *  a peer — the row then holds someone else's claim, and a tab that is still
 *  writing gets told a peer is converting, loses its own progress line, loses
 *  "anything still in flight here is no longer protected", and is handed a
 *  button to delete that peer's live claim. So `claimed` is asked first, and a
 *  claim that is not ours cannot outrank it. */
const holderOf = (
  claim: GraphBackfillClaim | null, localRun: LocalRunSnapshot | null,
): ClaimHolder | null => {
  const ours = claim !== null && claim.claimantId === getClientId()
  // Our own run took a claim and the live one is not it. Covers a claim that is
  // simply gone (released, or completed) and one that has been REPLACED, which
  // reads identically from here: either way this tab's writes are unprotected.
  if (localRun?.claimed === true && !ours) {
    // GONE versus REPLACED. Both mean this tab's writes are unprotected, and
    // the row cannot tell them apart from the claimant alone — but a claim that
    // is live means undo is paused again and someone else is rewriting the
    // graph right now, which is the opposite of what the gone case says.
    return claim === null
      ? {kind: 'lost-claim', message: localRun.message}
      : {kind: 'superseded', message: localRun.message, claim}
  }
  // No claim and our run has not taken one: the window between the confirmation
  // and the claim write, which holds two preflight reads and a page-ensure.
  // Without this arm the operator confirms a one-way fleet-wide flip and the
  // app simply goes quiet.
  if (claim === null) {
    return localRun === null ? null : {kind: 'starting', message: localRun.message}
  }
  if (!ours) return {kind: 'another-device', claim}
  // Ours, but only `this-tab` if OUR RUN is the one holding it. A sibling tab's
  // claim reads as ours, and telling this tab that closing it stops the run
  // would be false — the run is in the other tab.
  return localRun?.claimed === true
    ? {kind: 'this-tab', message: localRun.message, claim}
    : {kind: 'this-browser', claim}
}

/** What is left on screen after the dialog goes. A TOAST rather than a line in
 *  the dialog, because the dialog unmounts at exactly the moment reloading
 *  starts to matter. Sticky, because the user it is for is a PEER — who never
 *  saw the operator's confirmation, whose own device kept undo entries the run
 *  has made stale, and who may have walked away for the several minutes the
 *  run took. */
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
