/** The progress/adherence numbers for one experiment, computed once so
 *  `LabPageContent`'s `ExperimentCard` (the dashboard) and
 *  `decorations/ExperimentFooter` (the block's own footer, in the protocol
 *  notes) show the same reading of the same schedule rather than two
 *  independently-drifting copies.
 *
 *  Pure — no `@/` import — so it is unit-testable without a repo, like the
 *  engine it composes.
 */
import {armForDate, scheduleProgress} from '../engine/schedule'
import type {Arm, ExperimentRecord, NightRecord} from '../engine/types'

export interface ExperimentSummary {
  progress: {night: number; total: number} | undefined
  tonightArm: Arm | undefined
  /** Over the nights that OWE a dose (`doseRequired`: intervention nights,
   *  and control nights too under a placebo). `undefined` when none has
   *  been logged yet — nothing to divide by, rendered as '—' by both
   *  callers. */
  adherence: {taken: number; of: number} | undefined
  withSession: number
}

export const summarizeExperiment = (
  experiment: ExperimentRecord,
  nights: readonly NightRecord[],
  /** Wake date of the sleep ahead — what the schedule is asked about. */
  tonight: string,
): ExperimentSummary => {
  const ownNights = nights.filter(n => n.experimentId === experiment.id)
  const owing = ownNights.filter(n => n.doseRequired)
  const taken = owing.filter(n => n.doseTaken === true).length
  return {
    progress: scheduleProgress(experiment.periods, tonight),
    tonightArm: armForDate(experiment.periods, tonight),
    adherence: owing.length > 0 ? {taken, of: owing.length} : undefined,
    withSession: ownNights.filter(n => n.main !== undefined).length,
  }
}
