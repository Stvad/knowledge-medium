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
import { INTERACTION_SERIES, STARTUP_SERIES, countRecords, loadRecords } from './load.js'
import { nextAnalysisSeq } from './store.js'
import {
  anyJudged,
  awaitingCurrentSample,
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
  /** Startup went unjudged because THIS session contributed no record — the
   *  recorder is independently togglable, so the usual cause is that it is off.
   *  Distinct from "still building": no amount of waiting resolves it, and
   *  saying otherwise sends the user to wait for something that will not come. */
  startupAwaitingCurrentSample: boolean
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
  /** Records ON DISK for each series, counted only when nothing was judged —
   *  the one state whose note reports them; `{0, 0}` otherwise, and no reader
   *  should take it for a count.
   *
   *  Distinct from `baseline` (what the judged comparisons rested on, 0 by
   *  construction whenever nothing was judged) AND from the loaded series
   *  length, which is capped at the comparison window and would report the cap
   *  for a client with hundreds of sessions. */
  recorded: { interaction: number; startup: number }
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
  const startupAwaitingCurrentSample = awaitingCurrentSample(startupResults)

  const regressions = regressionsIn([...interactionResults, ...startupResults])

  // Two extra counts, and only in the state that reports them: with anything
  // judged the verdict names what it rested on instead, and these would be two
  // queries per analysis for a string nobody renders.
  const recorded = interactionReady || startupReady
    ? { interaction: 0, startup: 0 }
    : {
        interaction: await countRecords(repo, workspaceId, INTERACTION_SERIES),
        startup: await countRecords(repo, workspaceId, STARTUP_SERIES),
      }

  // Graph size is the dominant confound for every timing here, and it is
  // REPORTED rather than corrected for. Filtering the baseline to comparable
  // graph sizes would quietly disable the monitor on a steadily growing graph
  // -- the normal case -- and normalizing assumes a per-query cost model that
  // does not exist. A query that got twice as slow because its input doubled is
  // also a real slowdown the user feels; what they need is to be able to tell
  // which kind it is.
  //
  // Measured over the WHOLE baseline window, not over the sessions supporting
  // any one regression — a query measurable in only some of them, or the
  // fan-out's "had writes" filter, leaves each metric resting on its own
  // subset. So this is not per-metric aligned, and the note says what it does
  // measure rather than implying it is that metric's own baseline. Aligning it
  // would mean carrying each result's supporting sessions through
  // `TrendResult`, which is a lot of machinery for a hint whose job is only to
  // prompt "was that code or data?".
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
    recorded,
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
    startupAwaitingCurrentSample,
    interactionComparable: session.attributable,
    graphGrowth,
  }
}
