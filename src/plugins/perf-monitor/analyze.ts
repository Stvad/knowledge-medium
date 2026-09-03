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
} from '@/plugins/interaction-metrics/sessionContext.js'
import { INTERACTION_SERIES, STARTUP_SERIES, countRecords, loadRecords } from './load.js'
import { nextAnalysisSeq } from './store.js'
import type { MonitorRun } from './monitorRun.js'
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

/** Why a series produced no verdict. Each resolves differently, which is the
 *  whole reason they are not one value: only `history-short` is fixed by
 *  waiting. */
export type UnjudgedReason =
  /** Page-global counters blended across workspaces; only a fresh page session
   *  makes them attributable again. */
  | 'blended-workspaces'
  /** This session produced no usable measurement to compare against — waiting
   *  supplies history, not a current sample. */
  | 'no-current-sample'
  /** Nothing recorded for this session, so the series is not growing at all.
   *  Each recorder is togglable independently of this monitor. */
  | 'not-recording'
  /** Genuinely short of history, and still filling. The one that waiting fixes. */
  | 'history-short'

export interface PerfAnalysis {
  workspaceId: string
  /** The monitor run this was computed under, stamped at the publication
   *  boundary. Null when nothing was running — a refresh from a dialog still
   *  mounted after the monitor was switched off — and such an analysis is
   *  returned to its caller but never reaches the store. */
  run: MonitorRun | null
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
  /** Derived from `unjudgedBecause`, never set beside it — the two cannot
   *  disagree about whether a series was judged. */
  ready: { interaction: boolean; startup: boolean }
  /** WHY each series went unjudged, or null where it was judged. The verdict
   *  layer renders these and must not re-derive them: three separate booleans
   *  used to say this, each invented next to the message it fed, and each in
   *  turn disagreed with what the comparison had actually concluded. */
  unjudgedBecause: { interaction: UnjudgedReason | null; startup: UnjudgedReason | null }
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

/** Everything a verdict is, EXCEPT which monitor run it belongs to. That is
 *  stamped at the publication boundary, by the caller that knows whether one is
 *  in force — this function is equally callable from a test with none. */
export type PerfComparison = Omit<PerfAnalysis, 'run'>

export const runPerfAnalysis = async (
  repo: Repo,
  workspaceId: string,
  now: number,
): Promise<PerfComparison> => {
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

  // Read off the comparison RESULTS, not off adjacent state. `recordId` says
  // whether this session claimed a row, which is a different question from
  // whether the live snapshot holds anything comparable — a session can own a
  // row and still measure nothing usable, and reporting that as "still
  // building" points at history the comparison never lacked.
  const interactionUnjudged: UnjudgedReason | null =
    !session.attributable ? 'blended-workspaces'
      : interactionReady ? null
        : awaitingCurrentSample(interactionResults) ? 'no-current-sample'
          : session.recordId === null ? 'not-recording'
            : 'history-short'
  const startupUnjudged: UnjudgedReason | null =
    startupReady ? null
      : awaitingCurrentSample(startupResults) ? 'no-current-sample'
        : 'history-short'

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
    ready: { interaction: interactionUnjudged === null, startup: startupUnjudged === null },
    unjudgedBecause: { interaction: interactionUnjudged, startup: startupUnjudged },
    graphGrowth,
  }
}
