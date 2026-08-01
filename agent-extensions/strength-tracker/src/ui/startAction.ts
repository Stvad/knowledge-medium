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

/** Take the user to a session, and say so when that is refused.
 *
 *  `navigateFromGlobalCommand` resolves to `null` — it never rejects — when a
 *  navigation-policy plugin vetoes the gesture or the navigation errors. A
 *  discarded `null` reports success while leaving you on the page you started
 *  from with a live session you were never shown, and it is self-perpetuating:
 *  that session is now standing, so every later Start navigates into the same
 *  veto and the action can never appear to do anything again. */
const showSession = async (
  repo: Repo,
  workspaceId: string,
  workoutId: string,
  what: string,
): Promise<void> => {
  const shown = await navigateFromGlobalCommand(repo, {blockId: workoutId, workspaceId})
  if (shown === null) console.warn(`[strength] ${what}, but could not be opened`, workoutId)
}

/** Ask what tonight is, then stamp it at `placement`.
 *
 *  Exported because the Strength Log page's button runs the SAME flow with a
 *  different placement — two entry points, one dialog, one set of races
 *  already thought about. */
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
  // is the load-bearing one: it decides `plan.day`, which is the day
  // `startSession`'s scan asks about. Taking it from the approved config keeps
  // "the day asked about" and "the day it lands on" one value by construction.
  const confirmed = {...fresh, planSource: snapshot.planSource, config: snapshot.config}

  const prescription = prescribeFor(confirmed, now, picks.session, picks.choices)
  const plan = planFromPrescription(prescription, snapshot.config.unit)
  // Deliberately NO second standing-session check. `startSession` asks that
  // question inside the transaction that writes — the only place the answer
  // cannot go stale — and hands back what it finds with `stamped: false`. The
  // pre-check that used to sit here was strictly weaker and behaved worse when
  // it fired, returning early and leaving the blank line behind. Falling
  // through clears the line, reports a refused navigation, and skips the
  // alt-choice recording, all by the code that handles an ordinary start.
  const {id: workoutId, stamped} = await startSession(
    repo, workspaceId, placement.parentId, plan, placement.position,
  )

  // Reported, not thrown: a leftover blank line is smaller than the action
  // appearing to have failed. `stamped` goes in because a peer's session is not
  // ours to move into the cursor's slot even when it shares a parent; the line
  // is cleared either way, having been opened to hold a session.
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
  // tracked variant as it was — and only when the session is the one these
  // picks configured. A start that lost the race hands back THEIR session, so
  // the alternative was never added to anything, and recording it would change
  // future prescriptions on the strength of a race you were not told about.
  // `choicesToRecord` narrows to the groups the confirmed prescription holds,
  // since flipping a variant and then switching session leaves the first
  // session's group in `picks`.
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
