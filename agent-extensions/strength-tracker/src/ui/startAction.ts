/** "Start a session" — the one gesture that creates blocks.
 *
 *  Order matters and is the whole point: read the plan, ask what tonight is,
 *  and only then write. The variant and `or`-group picks are settled BEFORE
 *  the stamp because blocks get created for what you chose — switching
 *  afterwards would mean deleting them, which is the prune-and-regenerate
 *  this design exists without. Cancelling writes nothing.
 *
 *  WHERE it lands is the caller's to say — see `placement.ts`. The shortcut
 *  puts it where your cursor is; the Strength Log page's button puts it on
 *  that page. Nothing here files it by a rule of its own.
 */

import type {Repo} from '@/data/repo.js'
import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.js'
import {openDialog} from '@/utils/dialogs.js'
import {navigateFromGlobalCommand} from '@/utils/navigation.js'

import {startSession, takePlaceOf} from '../km/session'
import {choicesToRecord, planFromPrescription} from '../km/sessionPlan'
import {writeAltChoice} from '../km/store'
import {ensureStrengthHome, prescribeFor, readProgram, standingSession} from '../km/tonight'
import {placeAtFocus, type Placement} from './placement'
import {StartSessionDialog, type StartSessionResult} from './StartSessionDialog'

export const START_SESSION_ACTION_ID = 'strength.startSession'

/** Ask what tonight is, then stamp it at `placement`.
 *
 *  Exported because the Strength Log page's button runs the SAME flow with a
 *  different placement — two entry points, one dialog, one set of races
 *  already thought about. */
/** Take the user to a session, and say so when that is refused.
 *
 *  `navigateFromGlobalCommand` resolves to `null` — it never rejects — when a
 *  navigation-policy plugin vetoes the gesture or the navigation errors. Every
 *  path out of this action ends in a navigation, and a discarded `null` is the
 *  same failure each time: the tap reports success while leaving you on the
 *  page you started from, with a live session you were never shown. Worse, it
 *  is self-perpetuating — that session is now standing, so every later Start
 *  finds it and navigates into the same veto, and the action can never appear
 *  to do anything again.
 *
 *  One helper because there is one rule; it existed inline on the create path
 *  only, which is exactly how the two short-circuits kept theirs unchecked. */
const showSession = async (
  repo: Repo,
  workspaceId: string,
  workoutId: string,
  what: string,
): Promise<void> => {
  const shown = await navigateFromGlobalCommand(repo, {blockId: workoutId, workspaceId})
  if (shown === null) console.warn(`[strength] ${what}, but could not be opened`, workoutId)
}

export const runStartSession = async (repo: Repo, placement: Placement): Promise<void> => {
  const workspaceId = repo.activeWorkspaceId
  // Nothing here is readable-only: it bootstraps the log page and settings
  // block before the dialog even opens. The footer and the set controls
  // already refuse; this was the one write path that did not.
  if (!workspaceId || repo.isReadOnly) return

  // Captured once: the dialog can sit open across midnight, and re-reading
  // the clock at stamp time would file the session on a different training
  // day than the one that was prescribed and shown.
  const now = new Date()
  const snapshot = await readProgram(repo, workspaceId)

  // A session already under way is not a new one to configure. This is the one
  // short-circuit that earns its place: everything below it is answerable
  // inside the stamping transaction, but a DIALOG is not — offering the picker
  // and then throwing your answer away is a question that should not have been
  // asked. Changing your mind mid-session is an outline edit: delete the lift
  // you are not doing.
  const standing = await standingSession(repo, workspaceId, snapshot, now)
  if (standing) {
    await showSession(repo, workspaceId, standing, 'a session is already under way')
    return
  }

  const picks = await openDialog(StartSessionDialog, {
    initialSession: prescribeFor(snapshot, now).session,
    warnings: snapshot.warnings,
    prescribeFor: (result: StartSessionResult) =>
      prescribeFor(snapshot, now, result.session, result.choices),
  })
  if (!picks) return

  // Re-read, because the dialog can sit open for a long time and another
  // device may have finished a session in that window — stamping from the
  // frozen snapshot would compute weights and re-entry cuts from a baseline
  // that is no longer the latest. The clock and your picks are kept; only
  // the history underneath them is refreshed.
  const fresh = await readProgram(repo, workspaceId)

  // ONE value for everything after this point. Only history and layoffs come
  // from the refreshed read: the PLAN stays the one that was previewed and
  // approved, because refreshing that too would stamp different lifts — or
  // the built-in fallback, if the outline stopped resolving mid-dialog —
  // than the list you confirmed.
  //
  // The knobs travel with the plan for the same reason, and `dayRolloverHour`
  // is the load-bearing one: it decides which training day this is, so it
  // decides `plan.day` — which is the day `startSession`'s standing-session
  // scan asks about. Taking it from the approved config keeps the day the scan
  // asks about and the day the session lands on the same value by
  // construction, rather than by two callers remembering to agree.
  const confirmed = {...fresh, planSource: snapshot.planSource, config: snapshot.config}

  const prescription = prescribeFor(confirmed, now, picks.session, picks.choices)
  const plan = planFromPrescription(prescription, snapshot.config.unit)
  // There is deliberately NO second standing-session check here. One used to
  // sit above this line, for the case where another client starts this
  // training day while the dialog is open — but `startSession` now asks that
  // question inside the transaction that writes, which is the only place the
  // answer cannot go stale, and hands back whatever it finds with
  // `stamped: false`. The pre-check was strictly weaker AND behaved worse when
  // it did fire: it returned early, so the blank line you ran this on was left
  // behind and the navigation it did was the one path still discarding its
  // result. Falling through clears the line, reports a refused navigation, and
  // skips the alt-choice recording on `!stamped` — all three by the same code
  // that handles an ordinary start.
  const {id: workoutId, stamped} = await startSession(
    repo, workspaceId, placement.parentId, plan, placement.position,
  )

  // Reported, not thrown: the session is real, and a leftover blank line is a
  // smaller thing than the action appearing to have failed.
  // `stamped` goes in: losing the start race hands back a peer's session, and
  // that one is not ours to move into the cursor's slot even when it happens
  // to sit under the same parent. The blank line is still cleared — it was
  // opened to hold a session and now there is one.
  await takePlaceOf(repo, workoutId, placement, stamped)
    .catch((error: unknown) => console.error('[strength] could not clear the empty line', error))

  // Navigate FIRST. The session exists from the line above, and a failure to
  // record a preference must not leave you looking at the page you started
  // from with a live workout you were never shown — least of all a persistent
  // one, which would make Start unable to reach the workout it just made.
  // See `showSession` for why the result is checked rather than discarded.
  await showSession(repo, workspaceId, workoutId,
    stamped ? 'the session was created' : 'a session was already under way')

  // Recorded only now the session exists, so a cancelled dialog leaves the
  // tracked variant exactly as it was. Narrowed to the groups the confirmed
  // prescription actually contains — flipping a variant while previewing one
  // session and then switching to another leaves the first session's group in
  // `picks`, and recording it would retrack a session you never started.
  // …and only when the session that exists is the one those picks configured.
  // A start that lost the race to a peer hands back THEIR session untouched,
  // so the alternative you chose was never added to anything; recording it
  // anyway would change what future sessions prescribe on the strength of a
  // race you lost and were not told about. Same rule as the cancelled dialog
  // below, for the same reason: a preference is recorded because a session was
  // started with it.
  if (!stamped) return
  const recording = choicesToRecord(picks.choices, prescription.exercises)
  // Nothing to record means nothing to bootstrap either: the home is created
  // here rather than at read time, and a discarded pick must not be the thing
  // that brings a settings block into existence.
  if (recording.length === 0) return
  try {
    const {settingsBlockId} = await ensureStrengthHome(repo, workspaceId)
    for (const {groupKey, optionKey, label} of recording) {
      await writeAltChoice(repo, settingsBlockId, groupKey, optionKey, label)
    }
  } catch (error) {
    // Reported, not thrown: the session is real and on screen, and losing a
    // preference is a smaller thing than the action appearing to have failed.
    console.error('[strength] could not record the variant choice', error)
  }
}

/** NORMAL_MODE, not GLOBAL, because the block you are on IS the argument: it
 *  is what "start one here" means, and a global action would have to go
 *  digging through the layout session for the active panel's focus to learn
 *  the same thing. The Strength Log page keeps a button for the case where
 *  you are not pointing anywhere in particular. */
export const startSessionAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: START_SESSION_ACTION_ID,
  description: 'Strength: start a session here',
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block}) => {
    const data = block.peek()
    if (!data) return
    // Loaded rather than peeked: "does this block already hold something" is
    // the difference between taking an empty line's place and burying the
    // session under a heading, and children are not on the row.
    const children = (await block.repo.block(block.id).children.load()) ?? []
    await runStartSession(block.repo, placeAtFocus({
      id: data.id,
      parentId: data.parentId,
      content: data.content,
      orderKey: data.orderKey,
      hasChildren: children.some(child => !child.deleted),
      // Types live in the bag, so this is also how "is it an empty todo, or a
      // property-schema definition, or any other record whose content is blank
      // by design" gets asked — see `isExpendableLine`.
      properties: data.properties,
    }))
  },
  defaultBinding: {keys: 'Control+Shift+l'},
}
