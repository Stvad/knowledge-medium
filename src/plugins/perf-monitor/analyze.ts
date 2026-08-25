/**
 * One analysis pass: read this client's stored series, compare the live session
 * against it, publish the verdict.
 */
import type { Repo } from '@/data/repo'
import {
  interactionComparable,
  interactionMetricsUIStateType,
  type InteractionRecordData,
} from '@/plugins/interaction-metrics/record.js'
import {
  startupMetricsUIStateType,
  type StartupRecordData,
} from '@/plugins/startup-metrics/record.js'
import { loadRecords } from './load.js'
import {
  fanoutRegression,
  queryRegressions,
  startupRegression,
  MIN_INTERACTION_HISTORY,
  MIN_STARTUP_HISTORY,
  type Regression,
} from './series.js'

export interface PerfAnalysis {
  workspaceId: string
  analyzedAt: number
  /** Interaction sessions of history the comparison had. */
  baselineSessions: number
  /** Worst first. Empty when nothing regressed. */
  regressions: Regression[]
  /** True when the series is too short to judge — reported distinctly from
   *  "nothing regressed", because they call for opposite reactions. */
  insufficientHistory: boolean
}

export const runPerfAnalysis = async (
  repo: Repo,
  workspaceId: string,
  now: number,
): Promise<PerfAnalysis> => {
  const interaction = await loadRecords<InteractionRecordData>(
    repo, workspaceId, interactionMetricsUIStateType.id, '$.interactionRecord',
  )
  const startup = await loadRecords<StartupRecordData>(
    repo, workspaceId, startupMetricsUIStateType.id, '$.startupRecord',
  )

  // The newest stored interaction record is THIS session's (it is updated in
  // place), so it is history for nothing and must not be its own baseline.
  const interactionBaseline = interaction.slice(1)
  const current = interactionComparable(repo.metrics())

  const regressions: Regression[] = [
    ...queryRegressions(current, interactionBaseline),
    fanoutRegression(current, interactionBaseline),
    startupRegression(startup),
  ]
    .filter((r): r is Regression => r !== null)
    .sort((a, b) => b.ratio - a.ratio)

  return {
    workspaceId,
    analyzedAt: now,
    baselineSessions: interactionBaseline.length,
    regressions,
    // Derived from what the comparisons actually consume, not from the
    // baseline length alone: with history that is long enough to look
    // sufficient but too short once the recent window is taken out, every
    // comparison necessarily returns null and the chip would report "no
    // slowdowns" for a comparison that never ran.
    insufficientHistory:
      interactionBaseline.length < MIN_INTERACTION_HISTORY &&
      startup.length < MIN_STARTUP_HISTORY,
  }
}
