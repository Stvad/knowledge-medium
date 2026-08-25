/**
 * One analysis pass: read this client's stored series, compare the live session
 * against it, publish the verdict.
 */
import type { Repo } from '@/data/repo'
import {
  countLiveBlocks,
  interactionComparable,
  interactionMetricsUIStateType,
  interactionSessionFor,
  type InteractionRecordData,
} from '@/plugins/interaction-metrics/record.js'
import {
  startupMetricsUIStateType,
  type StartupRecordData,
} from '@/plugins/startup-metrics/record.js'
import { INTERACTION_RECORD_PATH, STARTUP_RECORD_PATH, loadRecords } from './load.js'
import {
  fanoutRegression,
  median,
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
  /** Per SERIES, because they fill up independently: every existing user has
   *  months of startup records and zero interaction records, and one `&&`
   *  across the two turns that state into "no slowdowns, compared against 0
   *  sessions" — a clean verdict from a comparison that never ran, which is
   *  the failure this feature exists to remove. */
  ready: { interaction: boolean; startup: boolean }
  /** True when NEITHER series can be compared yet. */
  insufficientHistory: boolean
  /** False when this page session's live counters cannot be attributed to one
   *  workspace, so only startup was compared. Surfaced rather than silently
   *  folded into a clean verdict. */
  interactionComparable: boolean
  /** Live graph size over the baseline's, when both are known. Not used to
   *  filter or normalize — see `runPerfAnalysis` — but reported alongside a
   *  regression so a reader can tell code from data growth. */
  graphGrowth: number | null
}

export const runPerfAnalysis = async (
  repo: Repo,
  workspaceId: string,
  now: number,
): Promise<PerfAnalysis> => {
  const interaction = await loadRecords<InteractionRecordData>(
    repo, workspaceId, interactionMetricsUIStateType.id, INTERACTION_RECORD_PATH,
  )
  const startup = await loadRecords<StartupRecordData>(
    repo, workspaceId, startupMetricsUIStateType.id, STARTUP_RECORD_PATH,
  )

  // The live counters are page-global. A page session that has seen a second
  // workspace carries both workspaces' work, so comparing that snapshot against
  // one workspace's history manufactures regressions. The recorder stops
  // sampling in that state; this reader holds the same snapshot and needs the
  // same rule -- it does not inherit it by the recorder having one.
  const session = interactionSessionFor(workspaceId)

  // Exclude THIS session's record by id, not by position: it is updated in
  // place, so it is history for nothing. Dropping the first row blindly would
  // discard a genuine past session in exactly the case where no current record
  // exists.
  const history = interaction.filter((r) => r.id !== session.recordId).map((r) => r.record)
  const current = interactionComparable(repo.metrics(), session.ownWrites)

  const interactionReady = session.attributable && history.length >= MIN_INTERACTION_HISTORY
  const startupReady = startup.length >= MIN_STARTUP_HISTORY

  const regressions: Regression[] = [
    ...(session.attributable
      ? [...queryRegressions(current, history), fanoutRegression(current, history)]
      : []),
    startupRegression(startup.map((r) => r.record)),
  ]
    .filter((r): r is Regression => r !== null)
    .sort((a, b) => b.ratio - a.ratio)

  // Graph size is the dominant confound for every timing here, and it is
  // REPORTED rather than corrected for. Filtering the baseline to comparable
  // graph sizes would quietly disable the monitor on a steadily growing graph
  // -- the normal case -- and normalizing assumes a per-query cost model that
  // does not exist. A query that got twice as slow because its input doubled is
  // also a real slowdown the user feels; what they need is to be able to tell
  // which kind it is.
  const baseCount = median(history.map((r) => r.blockCount).filter((n) => n > 0))
  // Counted live, not read off the newest record: the timings on the current
  // side of every comparison are live too, so the graph size paired with them
  // has to be the one they actually ran against.
  const liveCount = await countLiveBlocks(repo, workspaceId)
  const graphGrowth = baseCount > 0 && liveCount > 0 ? liveCount / baseCount : null

  return {
    workspaceId,
    analyzedAt: now,
    baselineSessions: history.length,
    regressions,
    // Derived from what the comparisons actually consume, not from the
    // baseline length alone: with history that is long enough to look
    // sufficient but too short once the recent window is taken out, every
    // comparison necessarily returns null and the chip would report "no
    // slowdowns" for a comparison that never ran.
    ready: { interaction: interactionReady, startup: startupReady },
    insufficientHistory: !interactionReady && !startupReady,
    interactionComparable: session.attributable,
    graphGrowth,
  }
}
