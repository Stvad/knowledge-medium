/** One analysis pass: compares the live session against this client's stored
 *  series. Does NOT publish — that's `runPerfAnalysisNow`'s job. */
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
  lacksBaseline,
  baselineWindow,
  fanoutRegression,
  median,
  queryRegressions,
  regressionsIn,
  startupRegression,
  type Regression,
  type TrendResult,
} from './series.js'

/** Why a series produced no verdict, kept distinct because each sends a
 *  reader somewhere different — none is final; the scheduler backs off and re-asks. */
export type UnjudgedReason =
  /** Page-global counters blended across workspaces — only a fresh page session makes them attributable again. */
  | 'blended-workspaces'
  /** No usable measurement yet this session. Interaction counters are live
   *  and become judgeable later; a startup record, once written, stays as-is. */
  | 'no-current-sample'
  /** Nothing recorded for this session — each recorder is togglable independently of this monitor. */
  | 'not-recording'
  /** Short of stored sessions, which accumulate on nobody's schedule — the ordinary cadence's business, not the fast recheck's. */
  | 'history-short'
  /** History enough, and all of it zero — no ratio can be formed, and telling the user to keep waiting points at the one thing that is fine. */
  | 'no-baseline'
  /** Partly judged: incomplete, not clean — the unjudged metric is exactly where a finding could be hiding. */
  | 'partly-judged'

export interface PerfAnalysis {
  workspaceId: string
  /** `metrics().epoch` this was computed under — `resetMetrics()` retires the counters without anything else here changing. */
  epoch: number
  /** Monitor run this was computed under, stamped at publication. Null means
   *  no run was in force — such an analysis never reaches the store. */
  run: MonitorRun | null
  analyzedAt: number
  /** Run order — two analyses starting in the same millisecond still differ; `analyzedAt` answers WHEN. */
  seq: number
  /** Worst first. Empty when nothing regressed. */
  regressions: Regression[]
  /** Per series, so a series with no history isn't reported clean on the
   *  other's strength. Derived from `unjudgedBecause`, never set independently. */
  ready: { interaction: boolean; startup: boolean }
  /** Per `awaitingSample` — what the scheduler reads to decide whether another look can change the answer. */
  awaitingLiveSample: { interaction: boolean; startup: boolean }
  /** Why each series' comparison is incomplete, or null if complete — rendered by the verdict layer rather than re-derived there. */
  unjudgedBecause: { interaction: UnjudgedReason | null; startup: UnjudgedReason | null }
  /** Sessions the judged comparisons actually rested on, not rows loaded — per series, since one shared number would misreport either verdict. */
  baseline: { interaction: number; startup: number }
  /** Records ON DISK per series, counted only when nothing was judged (`{0,
   *  0}` otherwise). Distinct from `baseline` and from the loaded series length, which is capped. */
  recorded: { interaction: number; startup: number }
  /** Live graph size over the baseline's. Not used to filter or normalize (see `runPerfAnalysis`) — reported so a reader can tell code from data growth. */
  graphGrowth: number | null
}

/** Everything a verdict is, except which monitor run it belongs to — stamped at publication by the caller. */
export type PerfComparison = Omit<PerfAnalysis, 'run'>

/** Why a series' comparison is incomplete, read off the RESULTS (plus
 *  `blended`/`notRecording`, session facts the results can't carry). Order
 *  matters: blended disqualifies first; something judged isn't thereby clean
 *  (a steady query beside an unratable fan-out would otherwise hide the
 *  unratable result); a missing current sample then outranks short history —
 *  it names the more specific gap, where pointing at history that wasn't short sends nobody anywhere. */
export const unjudgedReason = (
  results: readonly TrendResult[],
  session: { blended?: boolean; notRecording?: boolean },
): UnjudgedReason | null =>
  session.blended ? 'blended-workspaces'
    : anyJudged(results) ? (partlyJudged(results) ? 'partly-judged' : null)
      : awaitingCurrentSample(results) ? 'no-current-sample'
        : session.notRecording ? 'not-recording'
          : lacksBaseline(results) ? 'no-baseline'
            : 'history-short'

/** Is a series waiting on a sample from THIS session, whatever else it
 *  judged? The scheduler needs this even where `reason` doesn't say so.
 *  `not-recording` counts too: this monitor can race the recorder's arming
 *  and see no record, indistinguishable from one that's genuinely OFF —
 *  treating it as awaited only costs a few backed-off passes. (Startup never hits this reason.) */
export const awaitingSample = (
  results: readonly TrendResult[],
  reason: UnjudgedReason | null,
): boolean => awaitingCurrentSample(results) || reason === 'not-recording'

export const runPerfAnalysis = async (
  repo: Repo,
  workspaceId: string,
  now: number,
): Promise<PerfComparison> => {
  // Allocated BEFORE the first await, else the run finishing first would win the lower seq.
  const seq = nextAnalysisSeq()
  // Live counters are page-global — a session touching a second workspace
  // would manufacture regressions against one workspace's history; this
  // reader needs the recorder's "blended" rule without inheriting it.
  // PEEK, not read: marking this workspace observed would wrongly disable
  // sampling for one that never actually blended anything.
  // Read BEFORE the history loads, which are themselves queries this session
  // would otherwise be measured on.
  const { metrics, session } = peekLiveSession(repo, workspaceId)

  // Both windows exclude THIS session at the READ, so neither can contribute to
  // the history it is judged against — and neither comes back one session short
  // of the history it reports, which filtering after the cap would do.
  // Interaction goes by block id (a live-counter session has no other identity,
  // and its record is updated in place, so position says nothing); startup by
  // boot time, which also addresses the row for `current`.
  const interaction = await loadRecords(
    repo, workspaceId, INTERACTION_SERIES, ({ id }) => id === session.recordId)
  const { window: startup, current: thisBoot } = await loadSeriesWithCurrent(
    repo, workspaceId, STARTUP_SERIES,
    { field: 'timeOriginMs', value: performance.timeOrigin },
  )

  const history = interaction.map((r) => r.record)
  const current = interactionComparable(metrics)

  // Judged, not counted: a record with no writes (or missing paint marks) carries no usable sample.
  const interactionResults: TrendResult[] = session.attributable
    ? [...queryRegressions(current, history), fanoutRegression(current, history)]
    : []
  const startupResults: TrendResult[] = [
    startupRegression(startup.map((r) => r.record), thisBoot),
  ]

  const interactionReady = anyJudged(interactionResults)
  const startupReady = anyJudged(startupResults)

  // Read off the comparison RESULTS, not adjacent state — a session can own a row and still measure nothing usable.
  const interactionUnjudged = unjudgedReason(interactionResults, {
    blended: !session.attributable,
    notRecording: session.recordId === null,
  })
  const startupUnjudged = unjudgedReason(startupResults, {})

  const regressions = regressionsIn([...interactionResults, ...startupResults])

  // Only counted in the state that reports them — otherwise unrendered queries.
  const recorded = interactionReady || startupReady
    ? { interaction: 0, startup: 0 }
    : {
        interaction: await countRecords(repo, workspaceId, INTERACTION_SERIES),
        startup: await countRecords(repo, workspaceId, STARTUP_SERIES),
      }

  // Graph size is REPORTED, not corrected for — filtering would disable the
  // monitor on a normal growing graph, and there's no cost model to normalize
  // against. Measured over the WHOLE baseline window, so it's a hint ("code or data?"), not a per-metric baseline.
  const baseCount = median(baselineWindow(history).map((r) => r.blockCount).filter((n) => n > 0))
  // Counted live, not off the newest record — the current side of every comparison is live too.
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
    // Derived from what the comparisons consumed, not baseline length alone
    // — else short-post-window history would misreport "no slowdowns".
    ready: { interaction: interactionReady, startup: startupReady },
    unjudgedBecause: { interaction: interactionUnjudged, startup: startupUnjudged },
    awaitingLiveSample: {
      interaction: awaitingSample(interactionResults, interactionUnjudged),
      startup: awaitingSample(startupResults, startupUnjudged),
    },
    graphGrowth,
  }
}
