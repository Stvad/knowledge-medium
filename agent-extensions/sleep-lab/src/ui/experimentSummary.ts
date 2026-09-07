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
  /** `undefined` when no intervention night has been logged yet — nothing
   *  to divide by, rendered as '—' by both callers. */
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
  const interventionNights = ownNights.filter(n => n.arm === 'intervention')
  const taken = interventionNights.filter(n => n.doseTaken === true).length
  return {
    progress: scheduleProgress(experiment.periods, tonight),
    tonightArm: armForDate(experiment.periods, tonight),
    adherence: interventionNights.length > 0 ? {taken, of: interventionNights.length} : undefined,
    withSession: ownNights.filter(n => n.main !== undefined).length,
  }
}
