import { FolderTree } from 'lucide-react'
import type { OperatorBackfillPass, OperatorBackfillResult, Repo } from '@/data/repo'
import {
  PROPERTY_CELL_BACKFILL_ID,
  flipBlockedByCellValues,
  onPropertyCellBackfillProgress,
  pendingValueCount,
  surveyPropertyCellRejections,
  type PropertyCellRejectionSurvey,
} from '@/data/internals/propertyCellBackfill'
import {
  applyPropertyDefinitionSynthesis,
  flipBlockedBySynthesis,
  planPropertyDefinitionSynthesis,
  type PropertyDefinitionSynthesisPlan,
} from '@/data/internals/propertyDefinitionSynthesis'
import {
  claimHoldsGraph,
  graphBackfillClaimBlockId,
  readGraphBackfillClaim,
  STRANDED_CLAIM_RECOVERY,
} from '@/data/internals/graphBackfillClaim'
import { getClientId } from '@/utils/clientId'
import { NAMES_IN_A_SENTENCE, describeNames } from '@/utils/nameList'
import { readIsChildBackedWorkspace, readWorkspaceOwnerId } from '@/data/workspaceSchema'
import {
  flipRejectionProvesNoWrite,
  flipWorkspaceToChildBackedProperties,
} from '@/data/workspaces'
import { isRemoteSyncActive } from '@/data/repoProvider'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.js'
import { openDialog } from '@/utils/dialogs.js'
import { dismissToast, showInfo } from '@/utils/toast.js'
import { reportMigrationProgress, type MigrationProgress } from './progressReport.ts'
import {
  ConfirmMigrationDialog, type NamedPropertyKeys,
} from './ConfirmMigrationDialog.tsx'

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
  `Not started — ${withPeriod(reason)} Nothing was changed. `
  + (retryable
    ? 'Try again shortly.'
    : 'Nothing is working on it either — retrying alone will not clear this.')

/** Why this device must not start the pass right now, and whether waiting is
 *  the remedy. */
interface Unfitness {
  readonly reason: string
  readonly retryable: boolean
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
  return gap === null ? null : {reason: gap.reason, retryable: gap.transient}
}

/** The synthesis advisory is sticky and re-runnable, so it needs a stable id or
 *  a second run stacks an identical toast beside the first. */
const SYNTHESIS_TOAST = {
  id: 'properties-migration-synthesis', duration: Number.POSITIVE_INFINITY,
} as const

/** The cell-VALUE advisory. Its own id rather than sharing the synthesis
 *  one: a workspace can hold both problems at once, and two toasts under one
 *  id means the second silently replacing the first. */
const CELL_VALUE_TOAST = {
  id: 'properties-migration-cell-values', duration: Number.POSITIVE_INFINITY,
} as const

/** The repair worklist. Its id lives here, beside the advisory's, so the
 *  showing and the dismissing cannot drift onto different ids. */
const WORKLIST_TOAST = {
  id: 'properties-migration-worklist', duration: Number.POSITIVE_INFINITY,
} as const

/** Prepended to EVERY outcome of a run that flipped, because the flip is
 *  fleet-wide and ONE-WAY while the pass is neither. Without it an operator whose
 *  pass then deferred read "Not started" and walked away believing the graph was
 *  as they left it — and on a connected device deferring is the expected ending,
 *  not a corner case. */
const FLIP_LANDED =
  'This workspace was switched to property blocks — that part is done, and it ' +
  'applies to everyone in the workspace.'

/** A plan category, as the confirmation reports it: the exact count, plus the
 *  keys the copy will name. Capped here rather than in the dialog so a
 *  workspace with thousands of orphan keys hands a React prop a handful of
 *  strings and not a copy of the plan. */
const namedKeys = (entries: readonly {key: string}[]): NamedPropertyKeys => ({
  count: entries.length,
  names: entries.slice(0, NAMES_IN_A_SENTENCE).map(entry => entry.key),
})

/** One sticky worklist, however many kinds of repair it names. Two toasts
 *  under one id would mean the second silently replacing the first. */
const joinNotes = (...notes: (string | undefined)[]): string | undefined => {
  const present = notes.filter((note): note is string => note !== undefined)
  return present.length > 0 ? present.join(' ') : undefined
}

/** What a finished run leaves for the operator surfaces to report. Named
 *  rather than spelled inline at each signature, because the two categories
 *  below arrived a round apart and the second had to reach every one of them. */
export interface RunCounts {
  blocksMaterializedTotal: number
  valuesMaterializedTotal: number
  /** Values a codec REFUSED — junk to repair, and the repair worklist. */
  unmigrated: number
  /** Cells SKIPPED for want of a registered schema — a different repair (find
   *  the plugin or seed that owns the key), and possibly a permanent one. */
  unresolved: number
  /** The keys behind {@link unresolved}, deduped and capped by the pass. */
  unresolvedNames: readonly string[]
}

export const describeOutcome = (
  result: OperatorBackfillResult,
  counts: RunCounts,
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
  counts: RunCounts,
  /** Already folded by the caller — the pass's own clear OR the gesture's. */
  cleared: boolean,
): {message: string; failed: boolean; followUp?: string} => {
  const {
    blocksMaterializedTotal, valuesMaterializedTotal, unmigrated,
    unresolved, unresolvedNames,
  } = counts
  // Raised on EVERY `ran` ending rather than only the one that moved nothing:
  // a run can migrate a thousand values and still have skipped a key whose
  // schema is gone, and that key is the one thing the operator must act on.
  // It is also what keeps the worklist alive — a skipped cell raises no
  // failure, so without this the run reads as "refused nothing" and clears a
  // list of repairs that never happened.
  const unresolvedNote = unresolved > 0
    ? `${unresolved.toLocaleString()} property value(s) were skipped because no `
      + `registered schema resolves their key (${describeNames(unresolvedNames)}) — `
      + 'they still have no blocks. Register or re-enable whatever defines those keys, '
      + 'then run this again.'
    : undefined
  switch (result.outcome) {
    case 'ran':
      // Asked of VALUES, over the whole RUN. "Did anything move" is a question
      // about values, and only the run-wide count can answer it: the converging
      // sweep is by definition the one that found nothing left pending, so its
      // per-sweep count is zero at the end of every successful run.
      //
      // Both "wrote no values" endings answered together, so a third cannot
      // slip between them: which one it is turns entirely on whether the values
      // were REFUSED or were never there.
      if (valuesMaterializedTotal === 0) {
        if (unmigrated > 0) {
          return {
            // Flagged, but deliberately NOT diagnosed. What the counters
            // reach here cannot separate a broken first run from a converged
            // graph whose only remaining cells are ones no codec will ever
            // accept: both write nothing and refuse the same count.
            //
            // That IS separable — the graph claim carries `completedAt`, and
            // this gesture already reads the claim before reclaiming it — but
            // the answer is not threaded into this function, so the message
            // states what happened and names no cause. Thread it if the
            // distinction is ever worth the parameter.
            message: `Nothing was migrated — all ${unmigrated.toLocaleString()} property ` +
              'value(s) the pass tried kept their cell value. See the console for which; ' +
              'a re-run reports the same ones until they are repaired.',
            failed: true,
            // Carried even here, where the banner already reports a problem:
            // the two repairs are different jobs and the skipped keys are the
            // only one the banner does not name.
            followUp: unresolvedNote,
          }
        }
        // Skipped cells are not the stop condition — they were never
        // attempted. Without this branch the run below announced a finished
        // migration over them, which is the report an operator STOPS on.
        if (unresolved > 0) {
          return {
            message: `Nothing was migrated — ${unresolved.toLocaleString()} property ` +
              'value(s) were skipped because no registered schema resolves their key, ' +
              'and every other value already had its blocks.',
            failed: true,
            followUp: unresolvedNote,
          }
        }
        // The runbook's stop condition, and the only report that can carry it.
        // The fall-through below reports `blocksMaterializedTotal`, which a
        // re-run over a finished workspace leaves at zero — so without this
        // branch the stop condition renders as "Migrated properties on 0
        // blocks.", the same sentence a totally broken run produces.
        //
        // NOT "nothing was written": synthesis may have minted definitions on
        // this same run, and the flip may have landed. This says only what it
        // knows, which is that no VALUE needed moving.
        return {
          message: 'Nothing left to migrate — every property value already has its ' +
            'blocks.',
          failed: false,
        }
      }
      return {
        message: `Migrated properties on ${blocksMaterializedTotal.toLocaleString()} blocks.`,
        // Surfaced through `done`, not `fail`: the pass DID complete, and
        // saying otherwise would send an operator looking for a broken run
        // rather than for the handful of values named in the console.
        failed: false,
        followUp: joinNotes(
          unmigrated > 0
            ? `${unmigrated.toLocaleString()} property value(s) could not be migrated and kept `
              + 'their cell value — see the console for which (first 50 shown). Repair them '
              + 'and run this again.'
            : undefined,
          unresolvedNote,
        ),
      }
    case 'deferred':
      return {
        // "Not started" only if NOTHING did: the pass aborts mid-run too, and a
        // run that flipped has already made its one irreversible change.
        //
        // `retryable` is read on BOTH branches. Past the flip `cleared` is
        // always true, so a branch that ignored it told every durable
        // blocker — a view gap nothing is draining, a workspace turned
        // read-only — to "run it again", which is the forever-retry loop
        // `retryable` exists to prevent.
        message: (cleared
          ? `Stopped before finishing — ${withPeriod(result.reason)} ` +
            (result.retryable === false
              ? 'Nothing is working on it, so running this again will not get further ' +
                'until that is fixed.'
              : 'Already-migrated blocks are skipped, so run it again.')
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
        // NOT "another tab": the claimant id is per browser PROFILE, so two
        // tabs share one claim and read it as their own — an overlap this
        // seam does not separate and never reports. Naming tabs here sent
        // operators to close one, which changes nothing.
        message: 'Another client holds this migration — another device, or this browser ' +
          `signed in elsewhere. Wait for it to finish; ${STRANDED_CLAIM_RECOVERY}.`,
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

/** The counts a run that never started migrated. `describeOutcome` reads them
 *  only on the `ran` branch, which a refusal cannot reach — spelled out rather
 *  than faked per call site so a future branch that does read them sees zeros
 *  and not a guess. */
const NOTHING_MIGRATED: RunCounts = {
  blocksMaterializedTotal: 0, valuesMaterializedTotal: 0, unmigrated: 0,
  unresolved: 0, unresolvedNames: [],
}

/** Everything {@link migrateUnderClaim} needs that was decided BEFORE the
 *  claim: the plan and the counts were taken to build the confirmation, and
 *  re-deriving them under the claim would ask a different question than the
 *  user answered. */
interface ClaimedMigration {
  readonly repo: Repo
  readonly workspaceId: string
  /** Whether the workspace was ALREADY child-backed, so the flip is skipped. */
  readonly childBacked: boolean
  readonly plan: PropertyDefinitionSynthesisPlan
  /** How many of the plan's candidates will actually be minted — zero for a
   *  refused plan, whose keys stay cell-only. */
  readonly willSynthesize: number
  readonly blockCount: number
  readonly banner: MigrationProgress
}

/** What the gesture WRITES, plus the report that follows it — everything that
 *  must happen with the graph-wide claim held.
 *
 *  Every `return` in here is a return from the CLAIMED region: the wrapper
 *  hands the claim back on all of them. */
const migrateUnderClaim = async (
  {repo, workspaceId, childBacked, plan, willSynthesize, blockCount, banner}: ClaimedMigration,
  pass: OperatorBackfillPass,
): Promise<void> => {
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
      // Reported, not decided. The drop has a half that must happen while the
      // minting transaction still holds the write lock, which is not reachable
      // from out here — so synthesis owns both halves and says whether it took
      // the history; this only has to tell the user.
      undoCleared ||= result.undoHistoryCleared
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
    // The cell survey AGAIN, and this is the one that guards the flip — the
    // pre-dialog answer was taken across a user-length pause, in which a sync
    // arrival or a raw write can land a value no codec carries. Past the flip
    // that cell is stranded for good, which is the whole hazard this gate
    // exists for.
    //
    // NOT a re-derivation of what the user consented to: `plan`, `blockCount`
    // and `willSynthesize` stay the pre-dialog ones deliberately (see
    // {@link ClaimedMigration}). This asks one question, it can only REFUSE,
    // and it changes nothing the confirmation promised.
    //
    // It shrinks the window rather than closing it — see the survey's own
    // declaration for why closing it is not on offer. Bounded by one scan
    // instead of by how long the dialog sat open, and only ever paid on the
    // flip path.
    //
    // ABOVE the active-workspace check below, not under it, though that costs
    // a wasted scan when the user has navigated away. That check earns its
    // keep by being the LAST thing before the flip, and a paginated walk of
    // every property bag is exactly the await that would stop it being that.
    // The alternative — a third check, after this — is what its own comment
    // refuses.
    let stillCarried: PropertyCellRejectionSurvey
    try {
      stillCarried = await surveyPropertyCellRejections(repo, workspaceId)
    } catch (err) {
      console.error('[properties-migration] could not re-survey stored cell values:', err)
      // Fail CLOSED. A read that threw says nothing about whether the
      // precondition holds, and this is the last thing between here and a
      // one-way step.
      banner.fail('Stopped before switching this workspace over: this device could not ' +
        're-check whether every stored property value can be carried as blocks ' +
        `(${err instanceof Error ? err.message : String(err)}). Nothing was switched.` +
        undoNote(undoCleared))
      return
    }
    const arrivedBlocked = flipBlockedByCellValues(stillCarried)
    if (arrivedBlocked !== null) {
      banner.fail(`Stopped before switching this workspace over. ${arrivedBlocked}` +
        undoNote(undoCleared))
      return
    }
    // The second of exactly TWO active-workspace checks, and the LAST thing
    // between here and the flip — anything awaited below it reopens the window
    // it closes. Not a rule applied at every await: each guards a step the
    // user cannot take back — the post-dialog one because a confirmation is a
    // user-length pause, this one because the flip is fleet-wide and
    // irreversible. Synthesis deliberately has neither — it writes dormant
    // blocks scoped to the workspace named in its own argument, so navigating
    // away withdraws nothing. Do not add a third.
    if (repo.activeWorkspaceId !== workspaceId) {
      banner.fail('Stopped before switching this workspace over: a different workspace ' +
        'is open now. Nothing was switched.' + undoNote(undoCleared))
      return
    }
    banner.update('Switching this workspace to property blocks…')
    // BEGUN before the flip, not after it — see `UndoManager.beginHistoryDrop`.
    // From the PATCH onward the workspace is child-backed for the whole graph,
    // and the flip is a round trip plus two local db calls, so a replay
    // `undo()` has already popped has room to commit a whole pre-flip row over
    // what are now live children.
    const undoDrop = repo.undoManagerFor(workspaceId).beginHistoryDrop()
    let localApplied: boolean
    try {
      ;({localApplied} = await flipWorkspaceToChildBackedProperties(repo, workspaceId))
    } catch (err) {
      console.error('[properties-migration] flip failed:', err)
      // Only when the rejection could NOT establish the outcome. The PATCH may
      // have landed, so keeping the history would leave every pre-flip entry
      // replayable over a flip that did — and the epoch has moved, so nothing
      // else would refuse them. Dropped on the side of the rows.
      //
      // A rejection whose re-read came back still saying `cell` proves nothing
      // was written, and charging the user their history for an ordinary
      // refusal — a trigger, a permission — would be a cost with no hazard.
      const provenNoWrite = flipRejectionProvesNoWrite(err)
      if (provenNoWrite) {
        // ABANDONED, not finished: nothing was written, so the history is not
        // owed — but the drop still has to END, or it refuses every replay in
        // this workspace until the page reloads.
        undoDrop.abandon()
      } else {
        undoDrop.finish()
        undoCleared = true
      }
      const cause = err instanceof Error ? err.message : String(err)
      // The definitions minted a moment ago DID land either way, and saying
      // "nothing" would be a small lie about a write that shows up on the
      // Properties page.
      const minted = synthesized > 0
        ? ` The ${synthesized.toLocaleString()} definition(s) added just before it are still there.`
        : ''
      // TWO ENDINGS, because this catch now knows which one it is and they ask
      // opposite things of the operator. "Nothing was migrated" is a claim, and
      // on the ambiguous branch it is one this code has just decided it cannot
      // make — it dropped the undo history precisely because the flip may have
      // landed, so telling them it did not would contradict the cost they were
      // charged and send them to re-run against a graph that already moved.
      banner.fail(provenNoWrite
        ? 'Could not switch this workspace to property blocks, so nothing was ' +
          `migrated: ${cause}${minted} They do nothing until this runs again.` +
          undoNote(undoCleared)
        : 'Could not tell whether this workspace was switched to property ' +
          `blocks: ${cause} It may have been — reload before running this again, ` +
          `and check the Properties page rather than assuming either way.${minted}` +
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
    // FINISHED here. A replay already in flight when the flip started was
    // refused when the drop began; this takes the entries still on the stack.
    //
    // THIS TAB ONLY (#684, #1007): a peer device's or another tab's pre-flip
    // entries are not cleared — a watcher was declined; the dialog says to reload.
    undoDrop.finish()
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
  let blocksMaterializedTotal = 0
  // Subscribed for the whole run, not just started with it: the pass reports
  // per committed batch, and a run of several minutes with a status line that
  // never moves is indistinguishable from a hung one.
  let unmigrated = 0
  let unresolved = 0
  let unresolvedNames: readonly string[] = []
  /** Everything the run left unmigrated, refused or skipped — asked of the
   *  pass rather than summed here, so a category it grows reaches this
   *  gesture without the gesture changing. */
  let pending = 0
  let valuesMaterializedTotal = 0
  const unsubscribe = onPropertyCellBackfillProgress(progress => {
    // The RUN's total, not this sweep's. They answer different questions: the
    // per-sweep count is "was what this sweep scanned acceptable", so on a
    // converged sweep it reports the WHOLE scan, and reading it here would
    // tell the operator the run migrated everything it had merely re-checked.
    blocksMaterializedTotal = progress.blocksMaterializedTotal
    valuesMaterializedTotal = progress.valuesMaterializedTotal
    unmigrated = progress.failureCount
    unresolved = progress.unresolvedCount
    unresolvedNames = progress.unresolvedNames
    pending = pendingValueCount(progress)
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
    const result = await pass.run()
    const {message, failed, followUp} = describeOutcome(
      result,
      {blocksMaterializedTotal, valuesMaterializedTotal, unmigrated,
       unresolved, unresolvedNames},
      {flipped: flipLanded, undoCleared},
    )
    if (failed) banner.fail(message)
    else banner.done(message)
    // Sticky and stable-id, and dismissed ONLY by a run that proved there is
    // nothing left to repair — a completed pass that left nothing pending.
    //
    // Both halves are load-bearing. Without the dismissal, the run that fixes
    // the values produces no `followUp` at all, so "N could not be migrated,
    // repair them and run this again" outlives the repair and ends up beside
    // a banner saying there is nothing left. But dismissing on every
    // followUp-less ending is worse: `deferred`, `held-by-peer`, `read-only`,
    // `already-running` and `failed` all verified NOTHING, and so does a `ran`
    // that refused every value — clearing a still-actionable worklist on those
    // loses the only list of what to repair.
    //
    // `pending`, not the refusal count: a cell skipped for want of a schema is
    // unmigrated and raises no failure, so a run that skipped every one of
    // them reported zero refusals and cleared a worklist nothing had repaired.
    //
    // DEFENCE IN DEPTH, and deliberately kept as such: every ending with
    // skipped cells now also raises a `followUp`, which takes the branch
    // above, so reverting this to the refusal count fails no test today. It
    // stays because the two branches would then disagree about what "nothing
    // left" means, and the next note this gesture stops raising would restore
    // the bug silently.
    if (followUp) showInfo(followUp, WORKLIST_TOAST)
    else if (result.outcome === 'ran' && pending === 0) dismissToast(WORKLIST_TOAST.id)
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
    // This workspace's claim row, read fresh each call — the pre-flight check
    // below and the post-run re-read in `finally` each need their own read.
    const readOurClaim = () => readGraphBackfillClaim(
      repo.db,
      graphBackfillClaimBlockId(workspaceId, PROPERTY_CELL_BACKFILL_ID),
      workspaceId,
    )
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
    // ANOTHER CLIENT already owns this workspace's run. Refused here rather
    // than at the claim, which is after the confirmation: that dialog asks
    // consent for a one-way fleet-wide flip and says nothing about a migration
    // already under way, so a user reaching the palette through the gate's own
    // modal would be shown the whole irreversible-change screen for a gesture
    // `tryClaim` is about to decline anyway. Not a guard — the claim is still
    // the arbiter — just a screen they should not be asked to read.
    //
    // OUR OWN claimant is deliberately let through: an inherited claim is
    // exactly the state a resume starts from, and "run this again to resume it"
    // is what the gesture's own report tells the operator to do.
    const owner = await readOurClaim()
    if (claimHoldsGraph(owner) && owner.claimantId !== getClientId()) {
      showInfo('Another client is already migrating this workspace. Wait for it to finish; '
        + 'the dialog it puts up on every device is where you can release its claim.')
      return
    }
    // Before the count and the confirmation: the dialog must not ask consent
    // for something the runner is about to refuse — including asking a
    // non-owner to consent to a flip the server will never let them make.
    // Re-taken after the dialog; this is the cheap early exit, not the guard.
    const ineligible = await passIsUnfit(repo, {workspaceId, needsFlip: !childBacked})
    if (ineligible !== null) {
      showInfo(notStarted(ineligible.reason, ineligible.retryable))
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
    // The CELL-level survey, and deliberately BELOW the key-level refusal: it
    // decodes every stored property value in the workspace, so a workspace the
    // cheap key survey already refuses never pays for it. It also answers the
    // dialog's block count, which keeps this the ONLY full walk of the property
    // bags between the palette and the confirmation.
    let survey: PropertyCellRejectionSurvey
    try {
      survey = await surveyPropertyCellRejections(repo, workspaceId)
    } catch (err) {
      console.error('[properties-migration] could not survey stored cell values:', err)
      showInfo('Could not check whether every stored property value can be carried as ' +
        `blocks, so nothing was changed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    const valuesBlocked = flipBlockedByCellValues(survey)
    // The same bargain as the key-level refusal one branch up, for the same
    // reason: only the way IN has a one-way step to guard, and refusing an
    // already-flipped workspace would withhold the backfill from every other
    // key over a handful that can never migrate.
    if (valuesBlocked !== null) {
      showInfo(valuesBlocked, CELL_VALUE_TOAST)
      if (!childBacked) return
    } else {
      // Only where the survey RAN. The key-level refusal above returns without
      // one, and taking down a "cannot migrate" banner over cells this run
      // never looked at would claim a repair nothing verified.
      dismissToast(CELL_VALUE_TOAST.id)
    }
    // A refused workspace reaches here only when the flip is not at stake. Its
    // candidates are then keys that stay cell-only, NOT keys about to be given
    // a definition — counting them as the latter would have the dialog promise
    // something the gesture then skips.
    const refusal = plan.refusal
    const willSynthesize = refusal === null ? plan.candidates.length : 0
    const blockCount = survey.blocksScanned
    if (!await openDialog(ConfirmMigrationDialog, {
      blockCount, childBacked,
      synthesizedKeys: namedKeys(refusal === null ? plan.candidates : []),
      // Those same candidates, under the heading that is true of them once the
      // refusal has taken minting off the table. A definition COULD back them;
      // what the refusal says is that this DEVICE will not mint one — a repair
      // the operator can make, which `unfixableKeys` would call permanent.
      stranded: refusal !== null && plan.candidates.length > 0
        ? {...namedKeys(plan.candidates), reason: refusal}
        : null,
      unfixableKeys: namedKeys(plan.blockers),
      repairableKeys: namedKeys(plan.brokenDefinitions),
      undecodableValueKeys: {...namedKeys(survey.keys), cells: survey.cells},
    })) return
    // Re-read AFTER the dialog. A confirmation is a user-length pause, and the
    // workspace pinned before it may not be the open one now — the runner's
    // own active-workspace check happens only after `tryClaim` has written a
    // Migrations page and a claim row, so the wrong graph would be touched
    // before anything refused.
    if (repo.activeWorkspaceId !== workspaceId) return

    // Reported into the dialog the CLAIM raises, not one this gesture opens —
    // see `MigrationGate`. That is why the progress line and the outcome go to
    // different places: the dialog closes when the claim clears, and several
    // outcomes below are reported on paths where no claim was ever taken.
    const banner = reportMigrationProgress(workspaceId, 'Migrating properties to blocks…')
    try {
      // ABOVE the synthesis block, not below it: below, the "Nothing was changed"
      // this prints is false the moment synthesis commits.
      //
      // Caught, because these are database reads and nothing else is watching
      // this await: a transient failure here would leave the gesture with no
      // outcome to report, over a pass that never started.
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
      // The claim is taken HERE: after the last precondition, before SYNTHESIS
      // (this gesture's first write), and not inside the pass (its last). What
      // two unclaimed devices produce is a definition for the same orphan key at
      // the same deterministic id carrying DIFFERENT presets — which presets a
      // device can prove is a local fact — so sync picks one and the children
      // the other migrated decode under a codec it does not declare. The seam
      // says how far that window narrows, and what it still leaves open.
      //
      // After the dialog, though, never before: a claim held across a
      // user-length pause blocks every other device while a dialog sits open,
      // and a tab closed at the dialog strands it — over a flipped workspace,
      // once the flip below has landed.
      const gesture = await repo.withOperatorBackfillClaim(
        workspaceId, PROPERTY_CELL_BACKFILL_ID,
        pass => migrateUnderClaim(
          {repo, workspaceId, childBacked, plan, willSynthesize, blockCount, banner}, pass),
      )
      if (!gesture.claimed) {
        // The same reporter the pass's own outcomes go through. Which step
        // turned this device away is an implementation detail of where the
        // claim sits; a second vocabulary for "another device owns this run"
        // would drift from the first.
        const {message, failed} = describeOutcome(gesture.result, NOTHING_MIGRATED)
        if (failed) banner.fail(message)
        else banner.done(message)
      }
    } finally {
      // A path that returns or throws without reporting an outcome would leave
      // the operator watching the dialog vanish with no account of the run.
      // Over EVERY exit from the moment reporting began, which is why the `try`
      // starts there rather than at the claim.
      banner.settleUnreported()
      // And then say whether the workspace was handed back. Nothing else can:
      // an interrupted or declined run leaves the claim in flight — a run that
      // only INHERITED one never releases it at all — and until it is finished
      // or released every device holds the waiting dialog up. The outcome
      // messages are written before any of that is known, and "run it again"
      // over a workspace that is still telling everyone to wait is the wrong
      // thing to be told.
      //
      // WHOSE claim decides what to advise, so the claimant is read and not
      // just its liveness: telling a device that a PEER holds the workspace to
      // "run this again here" sends it into a refusal it can never win, and
      // pointing it at the release points it at deleting a claim another
      // device is still writing under.
      //
      // claimantId is per browser PROFILE — see describePassOutcome's
      // held-by-peer comment. So "this device" can also be a sibling tab, or
      // this gesture's own earlier invocation that the single-flight turned
      // away. Hence the conditional wording rather than an instruction to
      // re-run: a second concurrent pass is what that would start.
      //
      // Caught, because this is a database read on a path that runs after the
      // outcome is already painted: a throw here would replace the gesture's
      // own exit with an unrelated one, and drop the note exactly when the read
      // that produces it is failing.
      const held = await readOurClaim().catch((err: unknown) => {
        console.error('[properties-migration] could not re-read the claim:', err)
        return null
      })
      if (claimHoldsGraph(held)) {
        banner.addNote(
          held.claimantId === getClientId()
            ? 'Every device is still waiting on this workspace: this device holds the '
              + 'migration until a run here finishes it. If one is still going — in '
              + 'this tab or another — let it; otherwise run this again to resume it, '
              + `or ${STRANDED_CLAIM_RECOVERY}.`
            : 'Every device is still waiting on this workspace: another device holds '
              + 'the migration. It stays that way until that device finishes — running '
              + `this here is declined while it does. If it never will, ${
                STRANDED_CLAIM_RECOVERY}.`,
        )
      }
    }
  },
})
