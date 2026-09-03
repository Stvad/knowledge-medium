/**
 * One analysis pass: read this client's stored series and compare the live
 * session against it, returning the comparison.
 *
 * It does NOT publish. Whether a comparison may reach the store depends on the
 * monitor run and the counter span it was computed under, which is
 * `runPerfAnalysisNow`'s business — and this function is equally callable from
 * a test with neither.
 */
import type { Repo } from '@/data/repo'
import {
  countLiveBlocks,
  interactionComparable,
} from '@/plugins/interaction-metrics/record.js'
import {
  peekLiveSession,
} from '@/plugins/interaction-metrics/sessionContext.js'
import { INTERACTION_SERIES, STARTUP_SERIES, countRecords, loadRecords } from './load.js'
import { nextAnalysisSeq } from './store.js'
import type { MonitorRun } from './monitorRun.js'
import {
  anyJudged,
  partlyJudged,
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
  /** This session produced no usable measurement to compare against.
   *
   *  Whether waiting helps depends on the SERIES, which is why the scheduler
   *  asks `awaitingLiveSample` rather than reading this. A startup record is
   *  immutable: written for this boot with its paint marks or not, and one
   *  present without them never becomes usable. Interaction counters are live,
   *  so a session measuring nothing comparable now becomes judgeable the moment
   *  someone edits — the same reason `nextAnalysisDelayMs` keeps rechecking it
   *  on a cost bound rather than a deadline. */
  | 'no-current-sample'
  /** Nothing recorded for this session, so the series is not growing at all.
   *  Each recorder is togglable independently of this monitor. */
  | 'not-recording'
  /** Genuinely short of history, and still filling. The one that waiting fixes. */
  | 'history-short'
  /** Some of the series WAS judged and some of it could not be. The verdict
   *  that follows is incomplete rather than clean: the metric that went
   *  unjudged is exactly where a finding could have been hiding. */
  | 'partly-judged'

export interface PerfAnalysis {
  workspaceId: string
  /** `metrics().epoch` this was computed under. A `resetMetrics()` retires the
   *  counters a verdict rests on while the Repo, the workspace and the run all
   *  stay put — so nothing else here can tell that the figures are gone. */
  epoch: number
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
  /** Per SERIES, because they fill independently. One `&&` across the two
   *  reports a series with no history as clean on the strength of the other —
   *  "no slowdowns, compared against 0 sessions", a verdict from a comparison
   *  that never ran, which is the failure this feature exists to remove. */
  /** Derived from `unjudgedBecause`, never set beside it — the two cannot
   *  disagree about whether a series was judged. */
  ready: { interaction: boolean; startup: boolean }
  /** Per `awaitingSample` — what the scheduler reads to decide whether another
   *  look can change the answer. */
  awaitingLiveSample: { interaction: boolean; startup: boolean }
  /** WHY each series' comparison is incomplete, or null where it was complete.
   *  The verdict layer renders these and must not re-derive them: a reason
   *  invented beside the message it feeds can disagree with what the comparison
   *  concluded. */
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

/** Why a series' comparison is incomplete, read off the RESULTS.
 *
 *  Ordered, and the order is the point. Blended counters disqualify the series
 *  before anything is asked of the comparison. A series with something judged
 *  is not thereby clean — one steady query alongside an unrateable fan-out jump
 *  would otherwise publish "no slowdowns" while dropping the result that could
 *  not be rated. Only past both of those does "why was nothing judged" arise,
 *  and there a missing current sample outranks short history because waiting
 *  fixes exactly one of them.
 *
 *  `blended` and `notRecording` are facts about the SESSION that the results
 *  cannot carry; everything else comes from the comparison itself. */
export const unjudgedReason = (
  results: readonly TrendResult[],
  session: { blended?: boolean; notRecording?: boolean },
): UnjudgedReason | null =>
  session.blended ? 'blended-workspaces'
    : anyJudged(results) ? (partlyJudged(results) ? 'partly-judged' : null)
      : awaitingCurrentSample(results) ? 'no-current-sample'
        : session.notRecording ? 'not-recording'
          : 'history-short'

/** Is a series waiting on a sample from THIS session, whatever else it managed
 *  to judge? A different question from the reason, which names the ONE thing to
 *  tell a reader — and the scheduler needs the answer even where the note does
 *  not mention it.
 *
 *  `not-recording` counts. On a normal boot this monitor and the interaction
 *  recorder arm on the same idle delay, so an analysis can win that race and
 *  see no record — indistinguishable from here from a recorder that is switched
 *  OFF. Reporting the guess as final both shows the user the wrong thing and
 *  stops the scheduler looking; treating it as awaited costs a recorder that
 *  really is off a handful of backed-off passes.
 *
 *  Startup never produces that reason (its `notRecording` is never passed — an
 *  absent or unusable boot row is already `no-current-sample`), so the clause is
 *  inert there rather than a case the two series disagree about. */
export const awaitingSample = (
  results: readonly TrendResult[],
  reason: UnjudgedReason | null,
): boolean => awaitingCurrentSample(results) || reason === 'not-recording'

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
  // This boot's row is kept whatever the cap: other tabs on this client write
  // newer boots while a long-lived page stays open, and enough of them would
  // otherwise hide the row `startupRegression` looks for — reporting no current
  // sample with it sitting on disk.
  const startup = await loadRecords(repo, workspaceId, STARTUP_SERIES,
    (r) => r.timeOriginMs === performance.timeOrigin)

  // The live counters are page-global. A page session that has seen a second
  // workspace carries both workspaces' work, so comparing that snapshot against
  // one workspace's history manufactures regressions. The recorder stops
  // sampling in that state; this reader holds the same snapshot and needs the
  // same rule -- it does not inherit it by the recorder having one.
  // PEEK, not read: observing is a claim about where this page has been, and
  // this pass is still reading history when the user can move on and reset the
  // counters — observing the workspace being analysed would then mark the fresh
  // span unattributable and disable sampling for a workspace that never blended
  // anything.
  const { metrics, session } = peekLiveSession(repo, workspaceId)

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
  const interactionUnjudged = unjudgedReason(interactionResults, {
    blended: !session.attributable,
    notRecording: session.recordId === null,
  })
  const startupUnjudged = unjudgedReason(startupResults, {})

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
    epoch: metrics.epoch,
    seq,
    recorded,
    baseline: {
      interaction: judgedBaselineCount(interactionResults),
      startup: judgedBaselineCount(startupResults),
    },
    regressions,
    // Derived from what the comparisons actually consume, not from the
    // baseline length alone: with history long enough to look sufficient but
    // too short once the recent window is taken out, every comparison comes
    // back `insufficient` and the chip would report "no slowdowns" for a
    // comparison that never ran.
    ready: { interaction: interactionReady, startup: startupReady },
    unjudgedBecause: { interaction: interactionUnjudged, startup: startupUnjudged },
    awaitingLiveSample: {
      interaction: awaitingSample(interactionResults, interactionUnjudged),
      startup: awaitingSample(startupResults, startupUnjudged),
    },
    graphGrowth,
  }
}
