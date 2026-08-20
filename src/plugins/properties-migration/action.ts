import { FolderTree } from 'lucide-react'
import type { OperatorBackfillResult, Repo } from '@/data/repo'
import {
  PROPERTY_CELL_BACKFILL_ID,
  countPropertyCellBackfillCandidates,
  onPropertyCellBackfillProgress,
} from '@/data/internals/propertyCellBackfill'
import { readIsChildBackedWorkspace } from '@/data/workspaceSchema'
import { flipWorkspaceToChildBackedProperties } from '@/data/workspaces'
import { isRemoteSyncActive } from '@/data/repoProvider'
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

/** Appended to EVERY outcome, not only the ones that could have written: past
 *  the flip the gesture clears the stack ITSELF, before it knows how the pass
 *  will end, so even "another client holds this migration" happens with the
 *  history already gone. The pass clears the
 *  workspace's undo stack on its first committed batch, and an operator who is
 *  not told finds their history silently gone — which the `ran` branch said
 *  and the abort branches, the ones that actually strand a half-done run,
 *  did not. */
const undoNote = (result: OperatorBackfillResult, alsoCleared = false): string =>
  result.undoHistoryCleared || alsoCleared
    ? ' Undo history for this workspace was cleared.' : ''

/** Prepended to EVERY outcome of a run that flipped, because the flip is
 *  fleet-wide and ONE-WAY while the pass is neither. Without it an operator whose
 *  pass then deferred read "Not started" and walked away believing the graph was
 *  as they left it — and on a connected device deferring is the expected ending,
 *  not a corner case. */
const FLIP_LANDED =
  'This workspace was switched to property blocks — that part is done, and it ' +
  'applies to everyone in the workspace.'

export const describeOutcome = (
  result: OperatorBackfillResult,
  counts: {
    blocksMaterialized: number
    valuesMaterializedTotal: number
    unmigrated: number
    orphanedOwnersSwept: number
  },
  editedUnderPass: boolean,
  {flipped}: {flipped: boolean} = {flipped: false},
): {message: string; failed: boolean; followUp?: string} => {
  const described = describePassOutcome(result, counts, editedUnderPass, flipped)
  return flipped ? {...described, message: `${FLIP_LANDED} ${described.message}`} : described
}

const describePassOutcome = (
  result: OperatorBackfillResult,
  counts: {
    blocksMaterialized: number
    valuesMaterializedTotal: number
    unmigrated: number
    orphanedOwnersSwept: number
  },
  editedUnderPass: boolean,
  flipped: boolean,
): {message: string; failed: boolean; followUp?: string} => {
  const {blocksMaterialized, valuesMaterializedTotal, unmigrated, orphanedOwnersSwept} = counts
  switch (result.outcome) {
    case 'ran':
      // On VALUES, not on blocks: `blocksMaterialized` counts blocks accepted in
      // FULL, so one junk key on every block reads as zero for a run that wrote
      // all the other keys. And on the RUN's total, not the last sweep's — past
      // the flip the converging sweep is by definition the one that found nothing
      // left pending, so a per-sweep zero is how every successful run ends.
      if (valuesMaterializedTotal === 0 && unmigrated > 0) {
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
          undoNote(result, flipped),
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
        // "Not started" only if NOTHING did: the pass aborts mid-run too, and a
        // run that flipped has already made its one irreversible change.
        message: (result.undoHistoryCleared || flipped
          ? `Stopped before finishing — ${withPeriod(result.reason)} Already-migrated blocks ` +
            'are skipped, so run it again.'
          : `Not started — ${withPeriod(result.reason)} Try again shortly.`) + undoNote(result, flipped),
        failed: true,
      }
    case 'failed':
      return {
        // No blanket "run it again": true for the give-up and for an
        // unexpected throw, false for a missing claim seam, which fails
        // identically every time. Each reason carries its own.
        message: `Stopped partway — ${withPeriod(result.reason)}${undoNote(result, flipped)}`,
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
          'block on the "System Migrations (km)" page and delete it to release the pass.' +
          undoNote(result, flipped),
        failed: true,
      }
    case 'already-running':
      return {
        message: 'The migration is already running on this device.' + undoNote(result, flipped),
        failed: false,
      }
    case 'read-only':
      return {
        message: 'This workspace is read-only, so the migration cannot write.'
          + undoNote(result, flipped),
        failed: true,
      }
    case 'not-found':
      return {
        message: `No migration is registered under "${PROPERTY_CELL_BACKFILL_ID}".`
          + undoNote(result, flipped),
        failed: true,
      }
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
    // Decides which HALVES of the gesture run, and it used to end it outright
    // ("already child-backed — nothing left to do"). Un-flipped means flip and
    // then backfill; already-flipped means backfill alone, doing the materially
    // smaller create-only job. The confirmation is where an operator finds out
    // which of the two they are starting.
    const childBacked = await readIsChildBackedWorkspace(repo.db, workspaceId)
    // Only the FLIP needs the server. `supabase` is built from BUILD-time env
    // while local-only is a RUNTIME choice, so the client is non-null and the
    // PATCH would really go out — from a session that promised to make no
    // Supabase request, against a workspace id the server has never seen. Refused
    // before the dialog rather than after it on a PostgREST string. An
    // already-flipped workspace still backfills here: that half is local.
    //
    // Deliberately a refusal and not a local-only flip (review suggested one).
    // Local-only is a session choice, not a property of the workspace, so the
    // same graph may well exist on the server — and a locally-written column
    // would be overwritten the next time that account syncs, leaving a workspace
    // that reads un-flipped over children the backfill had already built. For a
    // genuinely local dev graph the escape hatch is `pnpm agent sql execute`.
    if (!childBacked && !isRemoteSyncActive()) {
      showInfo('This session is local-only, so the workspace cannot be switched to ' +
        'property blocks — that step needs remote sync.')
      return
    }
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
    let undoClearedByFlip = false
    if (!childBacked) {
      // FIRST, and that ordering is the whole point. The flip is what turns the
      // live maintainers on, so a workspace flipped with zero children keeps
      // reading cells (§5's pending-materialization fallback) while every new
      // write starts growing children — and the pass below only has history
      // left to fill in. Backfilling first instead opens a window where
      // machinery exists that nothing recognizes and nothing maintains.
      // The runner's own preconditions, taken BEFORE the one-way half rather
      // than after it. They otherwise run inside `runWorkspaceBackfillNow`, i.e.
      // once the flip has already landed — and then decline, which on a connected
      // device is the EXPECTED ending. The runner re-checks both; what this adds
      // is the ORDER.
      const unfit = repo.isReadOnly
        ? 'this workspace is read-only'
        : await repo.syncViewGap()
      if (unfit !== null) {
        banner.fail(`Not started — ${withPeriod(unfit)} Nothing was changed; try again shortly.`)
        return
      }
      banner.update('Switching this workspace to property blocks…')
      let localApplied: boolean
      try {
        ;({localApplied} = await flipWorkspaceToChildBackedProperties(repo, workspaceId))
      } catch (err) {
        console.error('[properties-migration] flip failed:', err)
        // "so nothing was migrated" is only true because this catch cannot see a
        // committed flip: the server write is the only thing that throws here.
        banner.fail('Could not switch this workspace to property blocks, so nothing ' +
          `was migrated: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      // Immediately, not by waiting for the pass's first committed batch. Undo
      // replay drives each row to a whole restored snapshot and SKIPS the same-tx
      // processors (`isReplay`), so a cmd-Z of a pre-flip edit puts a cell back
      // without the materializer syncing its children — and past the flip the
      // children are the truth, so the two just diverge. Every way the run can
      // end after this point without writing a batch (a peer holds the claim, the
      // runner defers, there is nothing left to migrate) leaves that window open.
      repo.undoManagerFor(workspaceId).clear()
      undoClearedByFlip = true
      if (!localApplied) {
        // The flip COMMITTED; this device just has no local `workspaces` row to
        // stamp yet, so the pass would read 'cell' and take the reconcile branch
        // on a workspace that is in fact flipped. Stop instead, and do not say
        // nothing happened.
        banner.fail(`${FLIP_LANDED} This device has not received the workspace row yet, ` +
          'so the migration could not run here — run this again once sync catches up.' +
          ' Undo history for this workspace was cleared.')
        return
      }
    }
    let materialized = 0
    // Subscribed for the whole run, not just started with it: the pass reports
    // per committed batch, and a run of several minutes with a silent toast is
    // indistinguishable from a hung one.
    let unmigrated = 0
    let valuesMaterializedTotal = 0
    let orphanedOwnersSwept = 0
    let editedUnderPass = false
    const unsubscribe = onPropertyCellBackfillProgress(progress => {
      materialized = progress.blocksMaterialized
      valuesMaterializedTotal = progress.valuesMaterializedTotal
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
        {blocksMaterialized: materialized, valuesMaterializedTotal, unmigrated, orphanedOwnersSwept},
        editedUnderPass,
        {flipped: undoClearedByFlip},
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
      // The runner can REJECT rather than return an outcome (a claim write that
      // throws before its own pass-level catch), and describeOutcome — which is
      // what otherwise carries these two sentences — never runs on that path. By
      // then the flip has committed and the undo stack is gone.
      banner.fail((undoClearedByFlip ? `${FLIP_LANDED} ` : '') +
        `Migration failed: ${err instanceof Error ? err.message : String(err)}` +
        (undoClearedByFlip ? ' Undo history for this workspace was cleared.' : ''))
    } finally {
      unsubscribe()
    }
  },
})
