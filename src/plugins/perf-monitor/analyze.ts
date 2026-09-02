/**
 * One analysis pass: read this client's stored series, compare the live session
 * against it, publish the verdict.
 */
import type { Repo } from '@/data/repo'
import {
  countLiveBlocks,
  interactionComparable,
} from '@/plugins/interaction-metrics/record.js'
import {
  readLiveSession,
  type RecordingBlocker,
} from '@/plugins/interaction-metrics/sessionContext.js'
import { INTERACTION_SERIES, STARTUP_SERIES, loadRecords } from './load.js'
import { nextAnalysisSeq } from './store.js'
import {
  anyJudged,
  judgedBaselineCount,
  baselineWindow,
  fanoutRegression,
  median,
  queryRegressions,
  regressionsIn,
  startupRegression,
  type Regression,
  type TrendResult,
} from './series.js'

export interface PerfAnalysis {
  workspaceId: string
  analyzedAt: number
  /** Run order, so two analyses that START in the same millisecond still have
   *  one. `analyzedAt` answers WHEN, which is a different question. */
  seq: number
  /** Worst first. Empty when nothing regressed. */
  regressions: Regression[]
  /** Per SERIES, because they fill up independently: every existing user has
   *  months of startup records and zero interaction records, and one `&&`
   *  across the two turns that state into "no slowdowns, compared against 0
   *  sessions" — a clean verdict from a comparison that never ran, which is
   *  the failure this feature exists to remove. */
  ready: { interaction: boolean; startup: boolean }
  /** False when this page session's live counters cannot be attributed to one
   *  workspace, so only startup was compared. Surfaced rather than silently
   *  folded into a clean verdict. */
  interactionComparable: boolean
  /** Non-null when recording is structurally impossible in this environment,
   *  so "still building a baseline" would be a promise that can never be kept. */
  recordingBlockedBy: RecordingBlocker | null
  /** Sessions the judged comparisons actually rested on — not rows loaded. Per
   *  series, because they fill independently and one number reported for the
   *  other tells a reader about history the verdict never used. */
  baseline: { interaction: number; startup: number }
  /** Live graph size over the baseline's, when both are known. Not used to
   *  filter or normalize — see `runPerfAnalysis` — but reported alongside a
   *  regression so a reader can tell code from data growth. */
  graphGrowth: number | null
}

/** The verdict for an environment that can never record, WITHOUT the history
 *  scans — there is nothing for them to find. Lets the chip state the case
 *  instead of the effect returning early and leaving it blank forever. */
export const blockedPerfAnalysis = (
  workspaceId: string,
  blockedBy: RecordingBlocker,
  now: number,
): PerfAnalysis => ({
  workspaceId,
  analyzedAt: now,
  seq: nextAnalysisSeq(),
  regressions: [],
  ready: { interaction: false, startup: false },
  interactionComparable: false,
  recordingBlockedBy: blockedBy,
  baseline: { interaction: 0, startup: 0 },
  graphGrowth: null,
})

export const runPerfAnalysis = async (
  repo: Repo,
  workspaceId: string,
  now: number,
): Promise<PerfAnalysis> => {
  // Allocated BEFORE the first await. The number answers "which run started
  // first", so taking it at return time would give the run that finishes first
  // the lower value — which is the ordering this exists to prevent.
  const seq = nextAnalysisSeq()
  const interaction = await loadRecords(repo, workspaceId, INTERACTION_SERIES)
  const startup = await loadRecords(repo, workspaceId, STARTUP_SERIES)

  // The live counters are page-global. A page session that has seen a second
  // workspace carries both workspaces' work, so comparing that snapshot against
  // one workspace's history manufactures regressions. The recorder stops
  // sampling in that state; this reader holds the same snapshot and needs the
  // same rule -- it does not inherit it by the recorder having one.
  const { metrics, session } = readLiveSession(repo, workspaceId)

  // Exclude THIS session's record by id, not by position: it is updated in
  // place, so it is history for nothing. Dropping the first row blindly would
  // discard a genuine past session in exactly the case where no current record
  // exists.
  const history = interaction.filter((r) => r.id !== session.recordId).map((r) => r.record)
  const current = interactionComparable(metrics)

  // Judged, not counted. A record with no writes, or a startup record missing
  // its paint marks, is a row that carries no usable sample — so readiness has
  // to come from whether a comparison actually produced a verdict.
  const interactionResults: TrendResult[] = session.attributable
    ? [...queryRegressions(current, history), fanoutRegression(current, history)]
    : []
  const startupResults: TrendResult[] = [
    startupRegression(startup.map((r) => r.record), performance.timeOrigin),
  ]

  const interactionReady = anyJudged(interactionResults)
  const startupReady = anyJudged(startupResults)

  const regressions = regressionsIn([...interactionResults, ...startupResults])

  // Graph size is the dominant confound for every timing here, and it is
  // REPORTED rather than corrected for. Filtering the baseline to comparable
  // graph sizes would quietly disable the monitor on a steadily growing graph
  // -- the normal case -- and normalizing assumes a per-query cost model that
  // does not exist. A query that got twice as slow because its input doubled is
  // also a real slowdown the user feels; what they need is to be able to tell
  // which kind it is.
  const baseCount = median(baselineWindow(history).map((r) => r.blockCount).filter((n) => n > 0))
  // Counted live, not read off the newest record: the timings on the current
  // side of every comparison are live too, so the graph size paired with them
  // has to be the one they actually ran against.
  const liveCount = await countLiveBlocks(repo, workspaceId)
  const graphGrowth = baseCount > 0 && liveCount > 0 ? liveCount / baseCount : null

  return {
    workspaceId,
    analyzedAt: now,
    seq,
    recordingBlockedBy: session.blockedBy,
    baseline: {
      interaction: judgedBaselineCount(interactionResults),
      startup: judgedBaselineCount(startupResults),
    },
    regressions,
    // Derived from what the comparisons actually consume, not from the
    // baseline length alone: with history that is long enough to look
    // sufficient but too short once the recent window is taken out, every
    // comparison necessarily returns null and the chip would report "no
    // slowdowns" for a comparison that never ran.
    ready: { interaction: interactionReady, startup: startupReady },
    interactionComparable: session.attributable,
    graphGrowth,
  }
}
