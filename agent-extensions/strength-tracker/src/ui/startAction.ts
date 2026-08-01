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

  // A session already under way is not a new one to configure. Offering the
  // picker again lets you choose the OTHER option of an `or`-group, and since
  // Start adopts the standing workout and adds the newly-chosen lift, the
  // session would end up holding both alternatives — with Finish recording
  // each. Changing your mind mid-session is an outline edit: delete the lift
  // you are not doing.
  const standing = await standingSession(repo, workspaceId, snapshot, now)
  if (standing) {
    await navigateFromGlobalCommand(repo, {blockId: standing, workspaceId})
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
  // The knobs travel with the plan for the same reason, and one of them is
  // load-bearing twice over: `dayRolloverHour` decides which training day
  // this is. Checking for an arrival with the fresh hour while stamping with
  // the approved one asks about a day the session will not land on, so a
  // peer's standing workout goes unseen and gets its alternative stamped
  // beside the one chosen here — exactly what the check exists to stop.
  const confirmed = {...fresh, planSource: snapshot.planSource, config: snapshot.config}

  // Asked AGAIN. Another client can start the same training day while this
  // dialog sits open, and stamping into it adds whichever alternative was
  // chosen here beside the one chosen there — the both-alternatives session
  // the pre-dialog check exists to prevent, arriving through the back door.
  const arrived = await standingSession(repo, workspaceId, confirmed, now)
  if (arrived) {
    await navigateFromGlobalCommand(repo, {blockId: arrived, workspaceId})
    return
  }

  const prescription = prescribeFor(confirmed, now, picks.session, picks.choices)
  const plan = planFromPrescription(prescription, snapshot.config.unit)
  // `arrived` is null here — the branch above returned if it was not. Passed
  // in so the stamping transaction can re-check the premise this whole flow
  // rests on: a session that turns up between that check and the write gets
  // continued rather than having tonight's picks stamped into it.
  const {id: workoutId, stamped} = await startSession(
    repo, workspaceId, placement.parentId, plan, placement.position, arrived,
  )

  // Reported, not thrown: the session is real, and a leftover blank line is a
  // smaller thing than the action appearing to have failed.
  await takePlaceOf(repo, workoutId, placement)
    .catch((error: unknown) => console.error('[strength] could not clear the empty line', error))

  // Navigate FIRST. The session exists from the line above, and a failure to
  // record a preference must not leave you looking at the page you started
  // from with a live workout you were never shown — least of all a persistent
  // one, which would make Start unable to reach the workout it just made.
  await navigateFromGlobalCommand(repo, {blockId: workoutId, workspaceId})

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
