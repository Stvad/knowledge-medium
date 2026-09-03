/**
 * One analysis pass: reads this client's stored series and compares the live
 * session against them. Does NOT publish — that's `runPerfAnalysisNow`'s job,
 * which is also why this function is equally callable from a test with no
 * monitor run in force.
 */
import type { Repo } from '@/data/repo'
import {
  countLiveBlocks,
  interactionComparable,
} from '@/plugins/interaction-metrics/record.js'
import {
  peekLiveSession,
} from '@/plugins/interaction-metrics/sessionContext.js'
import { INTERACTION_SERIES, STARTUP_SERIES, countRecords, loadRecords, loadSeriesWithCurrent } from './load.js'
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

/** Why a series produced no verdict, kept distinct because each resolves
 *  differently — only `history-short` is fixed by waiting. */
export type UnjudgedReason =
  /** Page-global counters blended across workspaces; only a fresh page
   *  session makes them attributable again. */
  | 'blended-workspaces'
  /** No usable measurement from this session yet. Whether waiting helps
   *  depends on the SERIES (see `awaitingLiveSample`): a startup record is
   *  immutable once written, but interaction counters are live and become
   *  judgeable the moment someone edits. */
  | 'no-current-sample'
  /** Nothing recorded for this session, so the series isn't growing at all.
   *  Each recorder is togglable independently of this monitor. */
  | 'not-recording'
  /** Genuinely short of history, and still filling. The one that waiting fixes. */
  | 'history-short'
  /** Partly judged: incomplete rather than clean — the unjudged metric is
   *  exactly where a finding could have been hiding. */
  | 'partly-judged'

export interface PerfAnalysis {
  workspaceId: string
  /** `metrics().epoch` this was computed under — needed because
   *  `resetMetrics()` retires the underlying counters without anything else
   *  here changing. */
  epoch: number
  /** Monitor run this was computed under, stamped at publication. Null means
   *  nothing was running (e.g. a dialog left mounted after the monitor was
   *  switched off); such an analysis returns to its caller but never reaches
   *  the store. */
  run: MonitorRun | null
  analyzedAt: number
  /** Run order, so two analyses that START in the same millisecond still have
   *  one; `analyzedAt` answers WHEN, a different question. */
  seq: number
  /** Worst first. Empty when nothing regressed. */
  regressions: Regression[]
  /** Per series — an `&&` across both would report a series with no history
   *  as clean on the strength of the other. Derived from `unjudgedBecause`,
   *  never set independently, so the two cannot disagree. */
  ready: { interaction: boolean; startup: boolean }
  /** Per `awaitingSample` — what the scheduler reads to decide whether
   *  another look can change the answer. */
  awaitingLiveSample: { interaction: boolean; startup: boolean }
  /** Why each series' comparison is incomplete, or null if complete. Rendered
   *  by the verdict layer rather than re-derived there, so the reason can
   *  never disagree with what the comparison concluded. */
  unjudgedBecause: { interaction: UnjudgedReason | null; startup: UnjudgedReason | null }
  /** Sessions the judged comparisons actually rested on, not rows loaded —
   *  per series, since one shared number would misreport history the other
   *  verdict never used. */
  baseline: { interaction: number; startup: number }
  /** Records ON DISK per series, counted only when nothing was judged
   *  (`{0, 0}` otherwise — never read it as a count). Distinct from
   *  `baseline` (what was judged) and from the loaded series length, which is
   *  capped at the comparison window. */
  recorded: { interaction: number; startup: number }
  /** Live graph size over the baseline's, when both are known. Not used to
   *  filter or normalize (see `runPerfAnalysis`) — reported so a reader can
   *  tell code growth from data growth. */
  graphGrowth: number | null
}

/** Everything a verdict is, except which monitor run it belongs to — that's
 *  stamped at the publication boundary, by the caller that knows whether one
 *  is in force. */
export type PerfComparison = Omit<PerfAnalysis, 'run'>

/** Why a series' comparison is incomplete, read off the RESULTS. Order
 *  matters: blended counters disqualify a series before anything is asked of
 *  the comparison; something judged isn't thereby clean (a steady query
 *  beside an unratable fan-out would otherwise publish "no slowdowns" and
 *  drop the unratable result); only past both does a missing current sample
 *  outrank short history, since waiting fixes only the former.
 *  `blended`/`notRecording` are SESSION facts the results can't carry —
 *  everything else comes from the comparison itself. */
export const unjudgedReason = (
  results: readonly TrendResult[],
  session: { blended?: boolean; notRecording?: boolean },
): UnjudgedReason | null =>
  session.blended ? 'blended-workspaces'
    : anyJudged(results) ? (partlyJudged(results) ? 'partly-judged' : null)
      : awaitingCurrentSample(results) ? 'no-current-sample'
        : session.notRecording ? 'not-recording'
          : 'history-short'

/** Is a series waiting on a sample from THIS session, whatever else it
 *  managed to judge? The scheduler needs this even where `reason` doesn't
 *  mention it. `not-recording` counts: on a normal boot this monitor can win
 *  the race against the interaction recorder arming and see no record —
 *  indistinguishable here from a recorder that's genuinely OFF. Treating it
 *  as awaited only costs an off recorder a handful of backed-off passes;
 *  treating it as final would show the user the wrong thing and stop the
 *  scheduler looking. Startup never hits this reason (an absent/unusable boot
 *  row is already `no-current-sample`), so the clause is simply inert there. */
export const awaitingSample = (
  results: readonly TrendResult[],
  reason: UnjudgedReason | null,
): boolean => awaitingCurrentSample(results) || reason === 'not-recording'

export const runPerfAnalysis = async (
  repo: Repo,
  workspaceId: string,
  now: number,
): Promise<PerfComparison> => {
  // Allocated BEFORE the first await — taking it at return time would give
  // the run that finishes first the lower value, inverting the ordering.
  const seq = nextAnalysisSeq()
  const interaction = await loadRecords(repo, workspaceId, INTERACTION_SERIES)
  // This boot's row comes back separately from the window, found however far
  // back the cap buried it, so this session can't land in its own baseline.
  const { window: startup, current: thisBoot } = await loadSeriesWithCurrent(
    repo, workspaceId, STARTUP_SERIES,
    { field: 'timeOriginMs', value: performance.timeOrigin },
  )

  // Live counters are page-global: a session that touched a second workspace
  // carries both workspaces' work, so comparing that snapshot against one
  // workspace's history manufactures regressions. The recorder stops sampling
  // in that state; this reader needs the same rule without inheriting it.
  // PEEK, not read: this pass reads history while the user can still move on
  // and reset the counters. Observing the workspace being analysed would mark
  // that fresh span unattributable and disable sampling for a workspace that
  // never actually blended anything.
  const { metrics, session } = peekLiveSession(repo, workspaceId)

  // Exclude THIS session's record by id, not position — it's updated in
  // place so carries no history. Dropping the first row blindly would discard
  // a genuine past session whenever no current record exists.
  const history = interaction.filter((r) => r.id !== session.recordId).map((r) => r.record)
  const current = interactionComparable(metrics)

  // Judged, not counted: a record with no writes, or a startup record missing
  // its paint marks, carries no usable sample — readiness has to come from
  // whether a comparison actually produced a verdict.
  const interactionResults: TrendResult[] = session.attributable
    ? [...queryRegressions(current, history), fanoutRegression(current, history)]
    : []
  const startupResults: TrendResult[] = [
    startupRegression(startup.map((r) => r.record), thisBoot),
  ]

  const interactionReady = anyJudged(interactionResults)
  const startupReady = anyJudged(startupResults)

  // Read off the comparison RESULTS, not adjacent state: `recordId` says
  // whether this session claimed a row, a different question from whether
  // the live snapshot holds anything comparable — a session can own a row and
  // still measure nothing usable.
  const interactionUnjudged = unjudgedReason(interactionResults, {
    blended: !session.attributable,
    notRecording: session.recordId === null,
  })
  const startupUnjudged = unjudgedReason(startupResults, {})

  const regressions = regressionsIn([...interactionResults, ...startupResults])

  // Two extra counts, and only in the state that reports them — with
  // anything judged the verdict names what it rested on instead.
  const recorded = interactionReady || startupReady
    ? { interaction: 0, startup: 0 }
    : {
        interaction: await countRecords(repo, workspaceId, INTERACTION_SERIES),
        startup: await countRecords(repo, workspaceId, STARTUP_SERIES),
      }

  // Graph size is REPORTED, not corrected for: filtering the baseline to
  // comparable sizes would disable the monitor on a normal steadily-growing
  // graph, and there's no per-query cost model to normalize against instead.
  //
  // Measured over the WHOLE baseline window, not the sessions supporting any
  // one regression, so it's not per-metric aligned — aligning it would mean
  // threading each result's supporting sessions through `TrendResult` for a
  // hint whose only job is "was that code or data?".
  const baseCount = median(baselineWindow(history).map((r) => r.blockCount).filter((n) => n > 0))
  // Counted live, not off the newest record: the current side of every
  // comparison is live too, so the paired graph size must match what it ran against.
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
    // Derived from what the comparisons actually consumed, not baseline
    // length alone — history that looks sufficient but is too short once the
    // recent window is excluded would otherwise report "no slowdowns" for a
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
