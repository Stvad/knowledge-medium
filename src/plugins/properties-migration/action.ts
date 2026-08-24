import { FolderTree } from 'lucide-react'
import type { OperatorBackfillResult, Repo, WorkspaceRematerialization } from '@/data/repo'
import {
  PROPERTY_CELL_BACKFILL_ID,
  countPropertyCellBackfillCandidates,
  onPropertyCellBackfillProgress,
} from '@/data/internals/propertyCellBackfill'
import {
  applyPropertyDefinitionSynthesis,
  flipBlockedBySynthesis,
  planPropertyDefinitionSynthesis,
  type PropertyDefinitionSynthesisPlan,
} from '@/data/internals/propertyDefinitionSynthesis'
import { readIsChildBackedWorkspace, readWorkspaceOwnerId } from '@/data/workspaceSchema'
import { flipWorkspaceToChildBackedProperties } from '@/data/workspaces'
import { isRemoteSyncActive } from '@/data/repoProvider'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.js'
import { openDialog } from '@/utils/dialogs.js'
import { dismissToast, showInfo, showProgress } from '@/utils/toast.js'
import { ConfirmMigrationDialog } from './ConfirmMigrationDialog.tsx'

/** The runner's reasons come from several places and only some end in a
 *  period, which is how "…partially materialized graph.. Try again" happened. */
const withPeriod = (reason: string | undefined): string =>
  reason === undefined ? '' : /[.!?]$/.test(reason) ? reason : `${reason}.`

/** Appended wherever a message has to say the history is gone.
 *
 *  The gesture clears the stack as soon as ANY of its writes lands — synthesis
 *  or the flip — and several branches can end the run after that point. One
 *  sentence in one place, rather than each branch remembering to add it. */
const undoNote = (cleared: boolean): string =>
  cleared ? ' Undo history for this workspace was cleared.' : ''

/** The one wording for "a precondition said no and nothing has been written".
 *  Three sinks use it — `showInfo` before the banner exists, `banner.fail`
 *  after, and the runner's own `deferred` outcome — and they must not drift,
 *  because which one fires is an implementation detail of where the check
 *  sits, not something the user can act on differently. */
const notStarted = (reason: string | undefined, retryable = true): string =>
  `Not started — ${withPeriod(reason)} Nothing was changed; `
  + (retryable
    ? 'try again shortly.'
    : 'and nothing is working on it — retrying alone will not clear this.')

/** Why this device must not start the pass right now, and whether waiting is
 *  the remedy. */
interface Unfitness {
  readonly reason: string
  readonly retryable: boolean
  /** The durable materialization gap, and only that.
   *
   *  The one unfitness a local pass can clear, which is why it is called out
   *  rather than inferred from `retryable: false` — read-only and non-owner are
   *  refusals about AUTHORITY, and re-materializing local rows moves neither. */
  readonly rematerializable?: boolean
  /** The reason is a COMPLETE message and the caller must not wrap it in
   *  {@link notStarted}, whose "Nothing was changed" is false after a repair
   *  that wrote local rows. */
  readonly standalone?: boolean
}

/** Why this device must not start the pass right now, or null. The runner takes
 *  these checks itself — but only after the claim, and in the flip case only
 *  after an irreversible server write. */
const passIsUnfit = async (
  repo: Repo,
  {workspaceId, needsFlip}: {workspaceId: string; needsFlip: boolean},
): Promise<Unfitness | null> => {
  if (repo.isReadOnly) return {reason: 'this workspace is read-only', retryable: false}
  // Ownership lives HERE, with the other preconditions, rather than as its own
  // check at one point in the sequence: this predicate is re-taken after the
  // confirmation, and ownership is exactly as capable of changing across that
  // pause as the sync gap is. A separate check would have to remember to be
  // re-taken; this one already is.
  //
  // Only when the flip is still ahead — an already-flipped workspace needs
  // nothing from the server, so a non-owner backfilling it is fine.
  if (needsFlip && await readWorkspaceOwnerId(repo.db, workspaceId) !== repo.user.id) {
    return {
      reason: 'only the workspace owner can switch this workspace to property blocks',
      retryable: false,
    }
  }
  // What follows is the FLIP, a one-way fleet-wide server write, so it takes
  // {@link Repo.workspaceViewGap}: rows this device never caught up with sit
  // there stably, with the queue long since drained and nothing in flight.
  // `transient` travels with the reason because the operator's only feedback is
  // this sentence — told "try again shortly" about a gap nothing will clear,
  // they retry forever.
  const gap = await repo.workspaceViewGap(workspaceId)
  return gap === null ? null : {
    reason: gap.reason,
    retryable: gap.transient,
    // The durable arm exactly. The transient one is the drain still working,
    // which a re-materialization would queue behind rather than help.
    rematerializable: !gap.transient,
  }
}

/**
 * Clear a durable materialization gap, then ask the gate again.
 *
 * Those rows reached the drain, could not be applied, and had their queue entry
 * consumed, so nothing re-delivers them and the refusal is permanent. The
 * remedy is a pass over rows this device already downloaded: local, uploading
 * nothing, claiming nothing, safe to repeat.
 *
 * FOUR things this deliberately does not do:
 *
 * - it does not weaken the gate. The predicate is re-taken afterwards and still
 *   holds its veto; what goes away is a manual step, not a check.
 * - it does not use the wide scope. That one is a full pass over the workspace
 *   and can leave the gap LARGER (`reflagged`), which is a deliberate operator
 *   choice and not something a migration does on someone's behalf.
 * - it does not loop. A gap the narrow pass cannot clear is `deferred` (the
 *   workspace is not materializable) or `quarantined` (ciphertext that will not
 *   decode), and neither is answered by running it again.
 * - it does not belong in `assertBackfillMayWrite`, the per-transaction
 *   re-check. That one re-samples while the write lock is held, dozens of times
 *   across a pass that runs for minutes; a repair there would be a
 *   minutes-long pass inside a gate meant to cost microseconds.
 * - it does not hand its own result to the migration. A repair that WROTE ends
 *   the gesture; the operator runs the migration again. See below — this is the
 *   one constraint here that is about data rather than cost.
 *
 * WHY A REPAIR THAT WROTE MUST NOT FEED THE MIGRATION. The pass can write an
 * older staged row over a local edit that is acked but not yet echoed back —
 * documented on `rematerializeWorkspace`, invisible to every predicate here,
 * and normally harmless because the echo re-asserts it moments later. Reading
 * that window INTO the migration is what makes it permanent: the backfill is
 * create-only over keys with no field row (`materializedFieldIds`), children
 * are the property truth and the cell only a derived read surface, so a child
 * minted from the reverted value is never revisited. The echo then heals the
 * cell and the child keeps the old value — a self-healing transient turned into
 * a lost edit, uploaded fleet-wide.
 *
 * Ending the gesture is the whole fix, and it is cheap: by the time a person
 * clicks again the echo has landed. It is also the categorical line the repo
 * draws anyway — a DERIVATION pass and a DATA MIGRATION are different kinds and
 * do not belong in one gesture.
 */
/** What the pass actually did, or null when it resolved nothing. Every exit
 *  that mentions the repair is built from this, so none can claim a catch-up
 *  that did not happen. */
const describeCatchUp = (repaired: WorkspaceRematerialization): string | null =>
  repaired.resolved === 0
    ? null
    : `Caught up on ${repaired.resolved.toLocaleString()} row(s) this device had downloaded `
      + 'but never applied.'

/** A complete operator sentence: what the repair did, then why the migration is
 *  not running. Either half may be the whole of it. */
const withCatchUp = (repaired: WorkspaceRematerialization, rest: string): string =>
  [describeCatchUp(repaired), rest].filter(Boolean).join(' ')

const repairThenRecheck = async (
  repo: Repo,
  {workspaceId, needsFlip}: {workspaceId: string; needsFlip: boolean},
): Promise<Unfitness | null> => {
  // Seconds at this scope on a real gap, but it is a pass over the DB and the
  // gesture has shown nothing yet — without a banner the command reads as hung.
  const banner = showProgress('Catching up on rows this device never applied…')
  let repaired: WorkspaceRematerialization
  try {
    repaired = await repo.rematerializeWorkspace(workspaceId, {scope: 'unapplied'})
  } catch (err) {
    console.error('[properties-migration] could not re-materialize before the pass:', err)
    // Its windows commit independently, so a rejection can still have rewritten
    // local rows: "Nothing was changed" would be false, and so would proceeding.
    // A re-taken gate can come back CLEAN here — the drain may have written
    // every window and failed only on a post-pass read — and continuing on that
    // would migrate the snapshot this just told the operator it did not trust.
    banner.fail('Could not finish catching up on rows this device never applied.')
    return {
      reason: 'Could not finish catching up on rows this device had not applied. Any rows it '
        + 'did reach are materialized and nothing was uploaded; the migration was not started. '
        + 'Run it again.',
      retryable: true,
      standalone: true,
    }
  }
  // The pass runs for MINUTES, so it is the one await here a person can
  // realistically navigate during. Everything downstream — the synthesis scan,
  // and a dialog asking about "this workspace" — would be for a workspace
  // nobody has open, ending in the post-dialog check's silent return.
  if (repo.activeWorkspaceId !== workspaceId) {
    banner.done()
    // No residual diagnosis here, deliberately: `deferred` / `quarantined` are
    // advice about the workspace they just LEFT, which they cannot act on from
    // where they are. Re-running there says it in full.
    return {
      reason: withCatchUp(repaired,
        'A different workspace is open now, so the migration was not started.'),
      retryable: true,
      standalone: true,
    }
  }
  // Caught for the same reason the post-dialog re-check is: these are database
  // reads, and a throw here would leave a duration-less banner spinning over a
  // gesture that has stopped.
  let stillUnfit: Unfitness | null
  try {
    stillUnfit = await passIsUnfit(repo, {workspaceId, needsFlip})
  } catch (err) {
    console.error('[properties-migration] could not re-check eligibility after repair:', err)
    banner.fail(withCatchUp(repaired, 'Could not re-check whether the migration may run.'))
    // Residual counts left out here as on the navigate-away exit: what the
    // operator can act on now is that the CHECK failed, and re-running gives
    // the deferred/quarantined diagnosis through the normal path.
    return {
      reason: withCatchUp(repaired,
        'Could not check whether the migration may run, so it was not started. Run it again.'),
      retryable: true,
      standalone: true,
    }
  }
  if (stillUnfit === null) {
    banner.done(describeCatchUp(repaired) ?? undefined)
    // ALWAYS, with no "it wrote nothing, so carry on" exception. Such an
    // exception has to read this invocation's counts, and they answer a
    // narrower question than the rule needs: two invocations racing here both
    // pass the gap check, the observer serializes their passes, and the second
    // sees flags the FIRST cleared — so it reports having written nothing and
    // would carry the first one's snapshot into the migration. "A repair ran,
    // so this gesture ends" is a rule about the gesture rather than about a
    // count, and nothing can race it.
    return {
      reason: withCatchUp(repaired, 'Run the migration again to continue.'),
      retryable: true,
      standalone: true,
    }
  }
  banner.done()
  return refusalAfterRepair(stillUnfit, repaired)
}

/**
 * A refusal that outlived the repair, phrased for what the repair did.
 *
 * ONE place answers this, for three refusals that do not look like the same
 * question: the gap survived and the counts explain it; the gap survived and
 * there is nothing to explain; or AUTHORITY changed underneath — the workspace
 * went read-only, or its owner did — in which case the counts explain nothing
 * about the refusal. The rule they share is that a committed repair invalidates
 * `notStarted`, whose "Nothing was changed" is false the moment a window lands;
 * held here rather than as a per-branch flag, which a branch can forget.
 */
const refusalAfterRepair = (
  stillUnfit: Unfitness,
  repaired: WorkspaceRematerialization,
): Unfitness => {
  // The counts belong only to a refusal the pass is still the reason for.
  const reason = stillUnfit.rematerializable
    ? `${stillUnfit.reason} (${describeResidualGap(repaired)})`
    : stillUnfit.reason
  if (repaired.applied === 0) return {...stillUnfit, reason}
  return {
    ...stillUnfit,
    standalone: true,
    reason: withCatchUp(repaired, `The migration was not started — ${reason}.`),
  }
}

/** Why the rows the repair could not apply are still there, in the pass's own
 *  terms — the part an operator acts on, since neither cause is answered by
 *  running it again. */
const describeResidualGap = (pass: WorkspaceRematerialization): string => {
  const parts: string[] = []
  if (pass.deferred > 0) {
    parts.push(`${pass.deferred.toLocaleString()} could not be read on this device — `
      + 'the workspace needs unlocking, or its encryption mode is unresolved')
  }
  if (pass.quarantined > 0) {
    parts.push(`${pass.quarantined.toLocaleString()} did not decrypt`)
  }
  return parts.length > 0
    ? `just re-checked: ${parts.join('; ')}`
    : 'just re-checked, and they did not move'
}

/** The synthesis advisory is sticky and re-runnable, so it needs a stable id or
 *  a second run stacks an identical toast beside the first. */
const SYNTHESIS_TOAST = {
  id: 'properties-migration-synthesis', duration: Number.POSITIVE_INFINITY,
} as const

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
  },
  {flipped, undoCleared}: {flipped: boolean; undoCleared: boolean}
    = {flipped: false, undoCleared: false},
): {message: string; failed: boolean; followUp?: string} => {
  const cleared = result.undoHistoryCleared || undoCleared
  const described = describePassOutcome(result, counts, cleared)
  // Both tails appended HERE, not inside the switch: a branch cannot forget a
  // suffix it does not apply, and every branch needs both.
  return {
    ...described,
    message: (flipped ? `${FLIP_LANDED} ` : '') + described.message + undoNote(cleared),
  }
}

/** What to tell the user, per outcome. `deferred` and `held-by-peer` are
 *  deliberately separate sentences: one means "retry in a moment", the other
 *  means "another device owns this run".
 *
 *  `followUp` is the part the operator has to ACT on. Shown as its own sticky
 *  toast rather than appended here: the banner's completion message clears in a
 *  couple of seconds and this pass runs for minutes, so nobody is still
 *  watching when it lands. */
const describePassOutcome = (
  result: OperatorBackfillResult,
  counts: {
    blocksMaterialized: number
    valuesMaterializedTotal: number
    unmigrated: number
  },
  /** Already folded by the caller — the pass's own clear OR the gesture's. */
  cleared: boolean,
): {message: string; failed: boolean; followUp?: string} => {
  const {blocksMaterialized, valuesMaterializedTotal, unmigrated} = counts
  switch (result.outcome) {
    case 'ran':
      // On VALUES, not on blocks: `blocksMaterialized` counts blocks accepted in
      // FULL, so one junk key on every block reads as zero for a run that wrote
      // all the other keys. And on the RUN's total, not the last sweep's — the
      // converging sweep is by definition the one that found nothing left
      // pending, so a per-sweep zero is how every successful run ends.
      if (valuesMaterializedTotal === 0 && unmigrated > 0) {
        return {
          message: `Nothing was migrated — all ${unmigrated.toLocaleString()} property ` +
            'value(s) failed. That is a systematic problem, not a handful of bad values; ' +
            'see the console before running this again.',
          failed: true,
        }
      }
      return {
        message: `Migrated properties on ${blocksMaterialized.toLocaleString()} blocks.`,
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
      return {
        // "Not started" only if NOTHING did: the pass aborts mid-run too, and a
        // run that flipped has already made its one irreversible change.
        message: (cleared
          ? `Stopped before finishing — ${withPeriod(result.reason)} Already-migrated blocks ` +
            'are skipped, so run it again.'
          : notStarted(result.reason, result.retryable)),
        failed: true,
      }
    case 'failed':
      return {
        // No blanket "run it again": true for the give-up and for an
        // unexpected throw, false for a missing claim seam, which fails
        // identically every time. Each reason carries its own.
        message: `Stopped partway — ${withPeriod(result.reason)}`,
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
      return {
        message: 'The migration is already running on this device.',
        failed: false,
      }
    case 'read-only':
      return {
        message: 'This workspace is read-only, so the migration cannot write.',
        failed: true,
      }
    case 'not-found':
      return {
        message: `No migration is registered under "${PROPERTY_CELL_BACKFILL_ID}".`,
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
 * given to any user. NOT reachable through `kmagent run-backfill`, which
 * refuses this backfill id on an un-flipped workspace: that verb is generic
 * over backfill ids and runs only the backfill half, so it would rebuild the
 * old backfill-then-flip order this gesture exists to delete.
 */
export const migratePropertiesToBlocksAction = ({repo}: {repo: Repo}): ActionConfig => ({
  id: 'migrate_properties_to_blocks',
  description: 'Migrate properties to child blocks (one-time)',
  context: ActionContextTypes.GLOBAL,
  icon: FolderTree,
  handler: async () => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    // Un-flipped: flip, then backfill. Already flipped: backfill alone.
    const childBacked = await readIsChildBackedWorkspace(repo.db, workspaceId)
    // Only the FLIP needs the server, and `supabase` is built from BUILD-time
    // env while local-only is a RUNTIME choice — so the client is non-null and
    // the PATCH really would go out. Refused rather than flipped locally:
    // local-only is a session choice, not a property of the workspace, so a
    // locally-written column loses to the next sync from that account and
    // leaves a workspace reading un-flipped over children it already has.
    if (!childBacked && !isRemoteSyncActive()) {
      showInfo('This session is local-only, so the workspace cannot be switched to ' +
        'property blocks — that step needs remote sync.')
      return
    }
    // Before the count and the confirmation: the dialog must not ask consent
    // for something the runner is about to refuse — including asking a
    // non-owner to consent to a flip the server will never let them make.
    // Re-taken after the dialog; this is the cheap early exit, not the guard.
    let ineligible = await passIsUnfit(repo, {workspaceId, needsFlip: !childBacked})
    // The one refusal with a local remedy: clear it and ask again, rather than
    // sending the operator away to run a verb by hand and come back.
    //
    // Guarded on the way IN too, not just on the way out (which the repair does
    // itself): starting a minutes-long pass plus block-cache growth for a
    // workspace already abandoned is pure waste. Neither side is the per-await
    // rule the two irreversibility guards below decline to be — this is the one
    // await in the gesture long enough for a person to navigate during it.
    if (ineligible?.rematerializable && repo.activeWorkspaceId === workspaceId) {
      ineligible = await repairThenRecheck(repo, {workspaceId, needsFlip: !childBacked})
    }
    if (ineligible !== null) {
      // A repair that ran owns its own sentence, complete: `notStarted`'s
      // "Nothing was changed" is false once local rows have been rewritten.
      showInfo(ineligible.standalone
        ? ineligible.reason
        : notStarted(ineligible.reason, ineligible.retryable))
      return
    }
    // §9 orphan synthesis, planned before the confirmation because this is the
    // step that can REFUSE — consent must not be asked for a migration that is
    // then declined.
    let plan: PropertyDefinitionSynthesisPlan
    try {
      plan = await planPropertyDefinitionSynthesis(repo, workspaceId)
    } catch (err) {
      console.error('[properties-migration] could not plan definition synthesis:', err)
      showInfo('Could not check which properties still need a definition, so nothing was ' +
        `changed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    const flipBlocked = flipBlockedBySynthesis(plan)
    // Only on the way IN to the flip. An already-flipped workspace has no
    // irreversible step left to guard, and refusing there would withhold the
    // backfill from every OTHER key over a handful this can never carry.
    if (flipBlocked !== null) {
      showInfo(flipBlocked, SYNTHESIS_TOAST)
      // A refusal on the way IN and an advisory once already flipped: only the
      // way in has an irreversible step to guard. Said on both paths — left to
      // the post-synthesis report it was dropped whenever there was nothing to
      // mint, which is exactly the unreadable-bag shape.
      if (!childBacked) return
    } else {
      // Sticky and stable-id, so an advisory from an earlier run outlives the
      // problem it named: this plan says the problem is gone, and leaving a
      // "cannot migrate" banner on screen through a migration that then
      // succeeds is worse than never having shown it.
      dismissToast(SYNTHESIS_TOAST.id)
    }
    // A refused workspace reaches here only when the flip is not at stake. Its
    // candidates are then keys that stay cell-only, NOT keys about to be given
    // a definition — counting them as the latter would have the dialog promise
    // something the gesture then skips.
    const willSynthesize = plan.refusal === null ? plan.candidates.length : 0
    const blockCount = await countPropertyCellBackfillCandidates(
      (sql, params) => repo.db.getAll(sql, params as unknown[] | undefined), workspaceId,
    )
    if (!await openDialog(ConfirmMigrationDialog, {
      blockCount, childBacked,
      synthesizedKeys: willSynthesize,
      unfixableKeys: plan.candidates.length - willSynthesize + plan.blockers.length,
      repairableKeys: plan.brokenDefinitions.length,
    })) return
    // Re-read AFTER the dialog. A confirmation is a user-length pause, and the
    // workspace pinned before it may not be the open one now — the runner's
    // own active-workspace check happens only after `tryClaim` has written a
    // Migrations page and a claim row, so the wrong graph would be touched
    // before anything refused.
    if (repo.activeWorkspaceId !== workspaceId) return

    const banner = showProgress('Migrating properties to blocks…')
    // ABOVE the synthesis block, not below it: below, the "Nothing was changed"
    // this prints is false the moment synthesis commits.
    //
    // Caught, because these are database reads: the banner has no duration and
    // nothing else is watching this await, so a transient failure here would
    // leave "Migrating properties to blocks…" spinning forever over a pass that
    // never started.
    let unfit: Unfitness | null
    try {
      unfit = await passIsUnfit(repo, {workspaceId, needsFlip: !childBacked})
    } catch (err) {
      console.error('[properties-migration] could not re-check eligibility:', err)
      // Retryable: a read that threw says nothing about whether the underlying
      // precondition holds, and a transient DB failure is exactly the kind that
      // clears on its own.
      unfit = {
        reason: `this device could not check whether the pass may run (${
          err instanceof Error ? err.message : String(err)})`,
        retryable: true,
      }
    }
    if (unfit !== null) {
      banner.fail(notStarted(unfit.reason, unfit.retryable))
      return
    }
    // BEFORE the flip, per the §9 runbook. A definition is an ordinary dormant
    // block at 'cell', so minting one early is free; minting one AFTER the flip
    // would leave a window in which the pass skips those keys and reports
    // success over them.
    let synthesized = 0
    // TWO flags, not one. The flip is what makes the workspace child-backed for
    // everyone; clearing the stack is a consequence of any write this gesture
    // commits, synthesis included. Collapsing them made an already-flipped run
    // that only synthesized announce a flip that never happened.
    let undoCleared = false
    let flipLanded = false
    if (willSynthesize > 0) {
      banner.update('Adding definitions for properties that have none…')
      try {
        const result = await applyPropertyDefinitionSynthesis(repo, plan)
        synthesized = result.created
        // About the entries ALREADY on the stack, not synthesis's own writes
        // (its transaction is `skipUndo`, and its Properties-page bootstrap is
        // a no-op — `kernel:properties` is a `systemPagesFacet` entry, so the
        // page exists before this gesture can be invoked). A key with no
        // definition was a key nothing materialized, so once one is MINTED a
        // replayed pre-synthesis snapshot writes a cell for a key that now has
        // children. Hence `created`, not "did this run": a run that only
        // converged changed nothing, and clearing then costs the user history
        // for no hazard.
        if (synthesized > 0) {
          repo.undoManagerFor(workspaceId).clear()
          undoCleared = true
        }
        // Asked AGAIN, with the OUTCOME. The pre-mint answer was about what we
        // expected to be able to do; this is about what actually happened, and
        // a key that came back skipped still has no definition. The backfill
        // excludes unregistered keys from its work list, so without this the
        // flip lands and the pass reports success with zero failures over a key
        // it silently could not migrate.
        const stillBlocked = flipBlockedBySynthesis(plan, result)
        if (!childBacked && stillBlocked !== null) {
          banner.fail(stillBlocked + undoNote(undoCleared))
          return
        }
        if (stillBlocked !== null) showInfo(stillBlocked, SYNTHESIS_TOAST)
      } catch (err) {
        console.error('[properties-migration] definition synthesis failed:', err)
        banner.fail('Could not add definitions for the properties that have none, so ' +
          `nothing was migrated: ${err instanceof Error ? err.message : String(err)}` +
          undoNote(undoCleared))
        return
      }
    }
    if (!childBacked) {
      // FIRST, and that is the whole point: the flip turns the live maintainers
      // on, so a workspace flipped with zero children keeps reading cells (§5's
      // pending-materialization fallback) while new writes grow children.
      // Backfilling first opens a window where machinery exists that nothing
      // recognizes and nothing maintains.
      // Assumes no workspace has run an earlier build's pass, so none holds
      // stale property machinery. Owner's call not to carry a check for a state
      // that cannot exist.
      // The second of the two IRREVERSIBILITY checks, and still not a rule
      // applied at every await. Each guards a step the user cannot take back:
      // the post-dialog one because a confirmation is a user-length pause, this
      // one because the flip is fleet-wide. Synthesis deliberately has neither —
      // it writes dormant blocks scoped to the workspace named in its own
      // argument, so navigating away withdraws nothing. Do not add a third on
      // this axis.
      //
      // The re-materialization repair brackets itself separately, on the
      // COST axis: it is the one await here long enough for a person to
      // navigate during it. That is not this rule eroding, and it is not a
      // licence to guard the cheap awaits.
      if (repo.activeWorkspaceId !== workspaceId) {
        banner.fail('Stopped before switching this workspace over: a different workspace ' +
          'is open now. Nothing was switched.' + undoNote(undoCleared))
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
        // The definitions minted a moment ago DID land, though — they are inert
        // at 'cell' and a re-run reuses them, but saying "nothing" would be a
        // small lie about a write that shows up on the Properties page.
        banner.fail('Could not switch this workspace to property blocks, so nothing ' +
          `was migrated: ${err instanceof Error ? err.message : String(err)}` +
          (synthesized > 0
            ? ` The ${synthesized.toLocaleString()} definition(s) added just before it ` +
              'are still there, and do nothing until this runs again.'
            : '') +
          undoNote(undoCleared))
        return
      }
      // Immediately, not by waiting for the pass's first committed batch. Undo
      // replay drives each row to a whole restored snapshot and SKIPS the same-tx
      // processors (`isReplay`), so a cmd-Z of a pre-flip edit puts a cell back
      // without the materializer syncing its children — and past the flip the
      // children are the truth, so the two just diverge. Every way the run can
      // end after this point without writing a batch (a peer holds the claim, the
      // runner defers, there is nothing left to migrate) leaves that window open.
      //
      // THIS DEVICE ONLY, deliberately (#684): a peer that stayed open across the
      // flip keeps its pre-flip entries, and nothing watches the column's arrival
      // to clear them. Declined rather than built — the stack is in-memory and the
      // transition happens once per workspace, so a watcher is permanent machinery
      // for a single scheduled event, and the damage a replayed pre-flip snapshot
      // does is a stale cell over live children, which the next write to those
      // children projects away. The dialog tells the operator to reload other
      // devices, which is what actually clears them.
      repo.undoManagerFor(workspaceId).clear()
      undoCleared = true
      flipLanded = true
      if (!localApplied) {
        // The flip COMMITTED; this device just has no local `workspaces` row to
        // stamp yet, so the pass would read 'cell' and refuse — every batch
        // re-asserts the flip. Stop here instead, with the message that says the
        // flip landed, rather than letting it fail on its own and report a
        // migration that broke.
        banner.fail(`${FLIP_LANDED} This device has not received the workspace row yet, ` +
          'so the migration could not run here — run this again once sync catches up.' +
          undoNote(undoCleared))
        return
      }
    }
    let materialized = 0
    // Subscribed for the whole run, not just started with it: the pass reports
    // per committed batch, and a run of several minutes with a silent toast is
    // indistinguishable from a hung one.
    let unmigrated = 0
    let valuesMaterializedTotal = 0
    const unsubscribe = onPropertyCellBackfillProgress(progress => {
      materialized = progress.blocksMaterialized
      valuesMaterializedTotal = progress.valuesMaterializedTotal
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
      const {message, failed, followUp} = describeOutcome(
        result,
        {blocksMaterialized: materialized, valuesMaterializedTotal, unmigrated},
        {flipped: flipLanded, undoCleared},
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
      banner.fail((flipLanded ? `${FLIP_LANDED} ` : '') +
        `Migration failed: ${err instanceof Error ? err.message : String(err)}` +
        undoNote(undoCleared))
    } finally {
      unsubscribe()
    }
  },
})
