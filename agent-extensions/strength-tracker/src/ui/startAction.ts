/** "Start a session" — the one gesture that creates blocks.
 *
 *  Order matters and is the whole point: read the plan, ask what tonight is,
 *  and only then write. The variant and `or`-group picks are settled BEFORE
 *  the stamp because blocks get created for what you chose — switching
 *  afterwards would mean deleting them, which is the prune-and-regenerate
 *  this design exists without. Cancelling writes nothing.
 *
 *  The session lands in the day's daily note, not on a dedicated page: it is
 *  a thing you did today, and it belongs where the rest of today is.
 */

import type {Repo} from '@/data/repo.js'
import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.js'
import {openDialog} from '@/utils/dialogs.js'
import {navigateFromGlobalCommand} from '@/utils/navigation.js'

import {startSession} from '../km/session'
import {planFromPrescription} from '../km/sessionPlan'
import {writeAltChoice} from '../km/store'
import {ensureStrengthHome, prescribeFor, readProgram, sessionParent, standingSession} from '../km/tonight'
import {StartSessionDialog, type StartSessionResult} from './StartSessionDialog'

export const START_SESSION_ACTION_ID = 'strength.startSession'

const runStartSession = async (repo: Repo): Promise<void> => {
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
  const prescription = prescribeFor(fresh, now, picks.session, picks.choices)
  const plan = planFromPrescription(prescription, fresh.config.unit)
  const parentId = await sessionParent(repo, workspaceId, prescription.day)
  const workoutId = await startSession(repo, workspaceId, parentId, plan)

  // Navigate FIRST. The session exists from the line above, and a failure to
  // record a preference must not leave you looking at the page you started
  // from with a live workout you were never shown — least of all a persistent
  // one, which would make Start unable to reach the workout it just made.
  await navigateFromGlobalCommand(repo, {blockId: workoutId, workspaceId})

  // Recorded only now the session exists, so a cancelled dialog leaves the
  // tracked variant exactly as it was. The home is created here rather than
  // at read time — this is the first moment anything is written to it.
  if (Object.keys(picks.choices).length === 0) return
  try {
    const {settingsBlockId} = await ensureStrengthHome(repo, workspaceId)
    for (const [groupKey, optionKey] of Object.entries(picks.choices)) {
      const option = prescription.exercises.find(exercise => exercise.altGroupKey === groupKey)
      await writeAltChoice(repo, settingsBlockId, groupKey, optionKey, option?.exercise ?? optionKey)
    }
  } catch (error) {
    // Reported, not thrown: the session is real and on screen, and losing a
    // preference is a smaller thing than the action appearing to have failed.
    console.error('[strength] could not record the variant choice', error)
  }
}

export const startSessionAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: START_SESSION_ACTION_ID,
  description: 'Strength: start a session',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}) => { await runStartSession(uiStateBlock.repo) },
  defaultBinding: {keys: 'Control+Shift+l'},
}
