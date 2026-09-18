/**
 * App-root mount that blocks the workspace for as long as the properties
 * migration holds its claim — on EVERY device, not just the one running it.
 *
 * Driven by the claim block, which is synced data. That is what makes this
 * reach a peer at all, and it is also what makes it survive a reload: there is
 * no session state to re-arm, so a tab opened midway through the run reads the
 * claim it already has and puts the dialog straight back up.
 *
 * Two things happen while the gate is up, and they are a pair:
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

  const holder = holderOf(claim, localRun)
  // The pause follows the DIALOG rather than the claim, which makes them one
  // state instead of two: a tab that has started the gesture has not written
  // yet, so pausing from there costs nothing and buys a sentence — "undo is
  // paused here" — that is true wherever the dialog is up.
  const gateOpen = holder !== null

  useEffect(() => {
    if (!gateOpen) return
    const drop = repo.undoManagerFor(workspaceId).beginHistoryDrop()
    // ABANDON, never finish. The refusal is the whole job here and `abandon`
    // keeps all of it — `dropsInProgress` is decremented by either ending, so
    // replays are refused for exactly as long as the gate is up.
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
  }, [repo, workspaceId, gateOpen])

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
 *  The LOCAL RUN is asked first, and that order is the whole guard: a claimant
 *  id is a browser profile, so the claim row cannot say whether THIS tab is the
 *  one writing — only the run knows. Read the row first and a tab that is
 *  mid-write, whose claim has been released or replaced underneath it (a click
 *  this dialog itself offers a peer), loses its own progress line and is handed
 *  a button to delete that peer's live claim. */
const holderOf = (
  claim: GraphBackfillClaim | null, localRun: LocalRunSnapshot | null,
): ClaimHolder | null => {
  if (localRun !== null) return {kind: 'this-tab', message: localRun.message}
  return claim === null ? null : {kind: 'running', claim}
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
