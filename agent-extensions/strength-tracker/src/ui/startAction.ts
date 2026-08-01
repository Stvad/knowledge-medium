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
import {prescribeFor, readProgram, sessionParent} from '../km/tonight'
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

  const picks = await openDialog(StartSessionDialog, {
    initialSession: prescribeFor(snapshot, now).session,
    warnings: snapshot.warnings,
    prescribeFor: (result: StartSessionResult) =>
      prescribeFor(snapshot, now, result.session, result.choices),
  })
  if (!picks) return

  const prescription = prescribeFor(snapshot, now, picks.session, picks.choices)
  const plan = planFromPrescription(prescription, snapshot.config.unit)
  const parentId = await sessionParent(repo, workspaceId, prescription.day)
  const workoutId = await startSession(repo, workspaceId, parentId, plan)

  // Recorded only now the session exists, so a cancelled dialog leaves the
  // tracked variant exactly as it was. After the stamp rather than before,
  // for the same reason: a preference that outlived a failed start would
  // describe a session that never happened.
  if (snapshot.settingsBlockId) {
    for (const [groupKey, optionKey] of Object.entries(picks.choices)) {
      const option = prescription.exercises
        .find(exercise => exercise.altGroupKey === groupKey)
      await writeAltChoice(repo, snapshot.settingsBlockId, groupKey, optionKey, option?.exercise ?? optionKey)
    }
  }

  await navigateFromGlobalCommand(repo, {blockId: workoutId, workspaceId})
}

export const startSessionAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: START_SESSION_ACTION_ID,
  description: 'Strength: start a session',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}) => { await runStartSession(uiStateBlock.repo) },
  defaultBinding: {keys: 'Control+Shift+l'},
}
