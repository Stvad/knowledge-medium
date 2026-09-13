/**
 * Is this session slower than this device's recent history? Pure. Three
 * judgements: COMPARE A DEVICE AGAINST ITSELF (thresholds don't survive a
 * fleet); A TREND ON BOTH SIDES (a fixed number misses gradual regressions,
 * a single session fires on every anomaly); MEDIAN NOT MEAN (sessions are
 * heterogeneous; the median tracks the typical one).
 */
import type {
  InteractionComparable,
  QueryTimingSample,
} from '@/plugins/interaction-metrics/record.js'
import type { StartupRecordData } from '@/plugins/startup-metrics/record.js'

/** Sessions of history required before any comparison is reported — below this the median is one arbitrary session with extra steps. */
export const MIN_BASELINE_SESSIONS = 5

/** How much worse than baseline counts as a regression — deliberately coarse, since tighter buys false positives from session noise, not earlier warning. */
const REGRESSION_RATIO = 2

/** Below this, a p95 isn't worth alarming on however much it grew — noise, not a regression a human can feel. */
const MIN_ABSOLUTE_MS = 5

/** Sessions smoothed into the "current" reading — the detection LAG for a just-landed regression, small enough to still notice within a day. */
const RECENT_WINDOW = 3

/** UNCONTENDED resolves needed before a query's p95 is treated as a
 *  measurement. Counted over those, not over every resolve: a caller's
 *  wall-clock on a busy connection pool is mostly the queue ahead of it, and N
 *  callers coalesced onto one statement are N copies of one observation. Both
 *  inflate a plain call count without adding anything to compare. */
const MIN_CALLS = 20

/** Widest p95/p50 still read as one clustered value — a 1% tolerance, NOT
 *  equality: stored timings are rounded to 0.01ms, so equality would be a
 *  stricter claim than this makes. Wide enough to absorb that rounding, far
 *  narrower than any spread distribution. */
const CLUSTERED_TAIL_MAX_RATIO = 1.01

/** Does the compared window's upper half collapse to one value?
 *
 *  Asked of the UNCONTENDED samples, the ones a comparison consumes. Request
 *  coalescing cannot produce this shape in them: callers sharing one statement
 *  are excluded at the source, before this predicate sees anything. What is
 *  left is a genuinely bimodal workload, where `sorted[floor(n * q)]` lets a
 *  slow half set p50 and p95 alike, and a window thin enough that its top 5% is
 *  one sample.
 *
 *  Still REPORTED and still never gating: a clustered tail is as often the
 *  regression worth seeing as an artifact of how few samples backed it, and
 *  discarding it would throw away the finding to suppress the artifact. */
export const hasClusteredTail = (u: {p50Ms: number; p95Ms: number}): boolean =>
  u.p50Ms >= MIN_ABSOLUTE_MS && u.p95Ms <= u.p50Ms * CLUSTERED_TAIL_MAX_RATIO

/** STORED sessions either comparison needs before it returns anything: the
 *  baseline, plus what current-window smoothing consumes on top of this
 *  session's own sample. One number, because both comparisons put this session
 *  on the recent side and take the rest from history. */
export const MIN_HISTORY_SESSIONS = MIN_BASELINE_SESSIONS + RECENT_WINDOW - 1

/** `insufficient` stays distinct from `steady` — collapsing "nothing judged"
 *  into "fine" would report a clean bill of health for a run that never happened. */
export type TrendResult =
  /** `reason` separates failure modes callers act on differently: 'history'
   *  fills by waiting; 'no-current-sample' may resolve without more history
   *  (live counters, a late-enabled recorder); 'no-baseline' is a FULL history
   *  that happens to be all zeros, where telling the user to keep waiting
   *  points at the one thing that is not the problem. */
  | { status: 'insufficient'; reason: 'history' | 'no-current-sample' | 'no-baseline' | 'never-uncontended' }
  /** `baselineCount` is sessions actually consumed, not rows loaded — rows with no usable sample are filtered out before the median. */
  | { status: 'steady'; baselineCount: number }
  | { status: 'regressed'; regression: Regression; baselineCount: number }

const INSUFFICIENT: TrendResult = { status: 'insufficient', reason: 'history' }
/** This session contributed no sample, so no amount of history helps. */
const NO_CURRENT_SAMPLE: TrendResult = { status: 'insufficient', reason: 'no-current-sample' }
/** History enough, and every session in it zero — there is no ratio to form. */
const NO_BASELINE: TrendResult = { status: 'insufficient', reason: 'no-baseline' }
/** Queries WERE measured, and not ONE of them was ever caught with the database
 *  free. Distinct from `no-current-sample`, which says the recorder produced
 *  nothing — and for a query that only ever runs inside a render fan-out this is
 *  the EXPECTED state, not a gap waiting closes. Reporting it as a missing
 *  sample would send a reader to look for a broken recorder.
 *
 *  Says NEVER, so it is claimed only when the count is actually zero. A session
 *  holding a handful of clean resolves that merely fall short of `MIN_CALLS` is
 *  still accumulating, and reporting that as "never" is a stronger statement
 *  than the data supports. */
const NEVER_UNCONTENDED: TrendResult = { status: 'insufficient', reason: 'never-uncontended' }

export interface Regression {
  /** Stable machine id, e.g. `query:groupedBacklinks.forBlock`. */
  metric: string
  /** One-line human form for the chip. */
  label: string
  baseline: number
  current: number
  /** current / baseline. Always > 1 for a reported regression. */
  ratio: number
  unit: 'ms' | 'ratio'
}

export const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Two decimals — shared with the trend table so a chart and a headline can't round the same rate differently. */
export const round2 = (n: number): number => Math.round(n * 100) / 100

/** Median of recent window vs baseline — insufficient / steady / regressed,
 *  never a bare absence. The one place thresholds are applied. */
const trendRegression = (
  spec: { metric: string; label: string; unit: 'ms' | 'ratio'; minAbsolute: number },
  recent: readonly number[],
  baseline: readonly number[],
): TrendResult => {
  // The recent side needs a FULL window, not merely non-empty — otherwise
  // the smoothing guarantee (one session can't swing a verdict) goes void exactly when history is thinnest.
  if (recent.length < RECENT_WINDOW || baseline.length < MIN_BASELINE_SESSIONS) return INSUFFICIENT
  const current = median(recent.slice(0, RECENT_WINDOW))
  const base = median(baseline)
  // Judged, and too small to matter — a verdict, not a gap in the data.
  if (current < spec.minAbsolute) return { status: 'steady', baselineCount: baseline.length }
  // A zero baseline is ambiguous: still-zero is genuinely unchanged (steady); zero-to-something has no ratio and would falsely
  // certify a regression as healthy, so it's insufficient instead — under its OWN reason, since the history a reader would then
  // be told to keep building is already full.
  if (base <= 0) return current === 0 ? { status: 'steady', baselineCount: baseline.length } : NO_BASELINE
  const ratio = current / base
  if (ratio < REGRESSION_RATIO) return { status: 'steady', baselineCount: baseline.length }
  return {
    status: 'regressed',
    baselineCount: baseline.length,
    regression: {
      metric: spec.metric,
      label: spec.label,
      baseline: round2(base),
      current: round2(current),
      ratio: round2(ratio),
      unit: spec.unit,
    },
  }
}

/** The sessions a per-query comparison reads, in the two roles it reads them
 *  as. Named once: the caveat reports on exactly what the comparison consumed,
 *  and a second copy of this slicing is how the two would come to disagree
 *  about which samples were involved. */
const comparisonWindows = <T>(history: readonly T[]): {
  recentPast: readonly T[]
  baselineSessions: readonly T[]
} => ({
  recentPast: history.slice(0, RECENT_WINDOW - 1),
  baselineSessions: baselineWindow(history),
})

/** Entries used as BASELINE from a newest-first history. The leading entries
 *  are consumed smoothing "current", so describing the baseline must derive from this same slice. */
export const baselineWindow = <T>(history: readonly T[]): readonly T[] =>
  history.slice(RECENT_WINDOW - 1)

/** A series is READY when at least one metric could be judged — row count alone isn't readiness; some rows carry no usable sample. */
export const anyJudged = (results: readonly TrendResult[]): boolean =>
  results.some((r) => r.status !== 'insufficient')

/** Some metric could not be judged. A verdict resting on the rest is INCOMPLETE, not clean — the unjudged one is where a finding could hide. */
export const partlyJudged = (results: readonly TrendResult[]): boolean =>
  results.some((r) => r.status !== 'insufficient') &&
  results.some((r) => r.status === 'insufficient')

/** At least one metric is short of a sample from THIS session, not of history
 *  — missing NOW, not necessarily forever. `some`, and deliberately no
 *  `anyJudged` guard: a set with one metric judged and another awaiting its
 *  sample is exactly what the scheduler must come back to, and requiring
 *  nothing to have been judged would stop it rechecking the unmeasured one.
 *
 *  `never-uncontended` counts: a session that has only navigated has no
 *  comparable timing YET, and the quiet stretch that produces one may still be
 *  coming. Leaving it out would stop the scheduler exactly where rechecking is
 *  the thing most likely to pay. */
export const awaitingCurrentSample = (results: readonly TrendResult[]): boolean =>
  results.length > 0 &&
  results.some((r) => r.status === 'insufficient' &&
    (r.reason === 'no-current-sample' || r.reason === 'never-uncontended'))

/** Nothing judged, and at least one metric had a full but all-zero baseline —
 *  the gap waiting cannot close. `some`, like `awaitingCurrentSample`: it names
 *  the more specific reason where one exists. */
export const lacksBaseline = (results: readonly TrendResult[]): boolean =>
  results.some((r) => r.status === 'insufficient' && r.reason === 'no-baseline')

/** Nothing comparable was measured, and waiting will not change that on this
 *  workload. `some`, like the two above: it names the more specific reason
 *  where one exists. */
export const lacksUncontendedSamples = (results: readonly TrendResult[]): boolean =>
  results.some((r) => r.status === 'insufficient' && r.reason === 'never-uncontended')

/** Sessions the THINNEST judged comparison rested on, or 0 if none was
 *  judged — smallest, not largest, so a clean verdict isn't overstated. */
export const judgedBaselineCount = (results: readonly TrendResult[]): number => {
  const counts = results.flatMap((r) => (r.status === 'insufficient' ? [] : [r.baselineCount]))
  return counts.length === 0 ? 0 : Math.min(...counts)
}

/** The regressions among these results, worst ratio first. The single place
 *  ordering is decided, so no caller has to re-sort and none can disagree. */
export const regressionsIn = (results: readonly TrendResult[]): Regression[] =>
  results
    .flatMap((r) => (r.status === 'regressed' ? [r.regression] : []))
    .sort((a, b) => b.ratio - a.ratio)

/** The subset of a query's stored sample this comparison can use: the resolves
 *  that ran with the DB connection pool to themselves. ONE definition, so the
 *  gate, the measurement and the caveat cannot disagree about which samples the
 *  verdict rested on.
 *
 *  Absent on records written before the recorder measured it, and on queries
 *  never once observed unopposed — both mean "no comparable measurement", which
 *  is why they read the same way here. */
const comparableSamples = (q: QueryTimingSample | undefined) =>
  q?.uncontended !== undefined && q.uncontended.calls >= MIN_CALLS ? q.uncontended : null

/** Per-query p95 regressions, worst ratio first. A query absent from the
 *  baseline is skipped, not infinitely regressed. `recentPast` smooths the current reading. */
export interface QueryComparison {
  results: TrendResult[]
  /** Metrics whose verdict rests on a session with a collapsed tail. Produced
   *  HERE, from the same walk that judged them, because it is the only place
   *  that knows which samples a query actually consumed and whether its
   *  comparison reached a verdict at all — re-deriving either alongside is how
   *  a caveat comes to qualify a trend that was never produced. */
  clusteredTail: string[]
}

export const queryRegressions = (
  current: InteractionComparable,
  history: readonly InteractionComparable[],
): QueryComparison => {
  const { recentPast, baselineSessions } = comparisonWindows(history)
  const results: TrendResult[] = []
  const clusteredTail: string[] = []
  /** Current queries the comparison could not judge. KEPT, not dropped: see below. */
  const skipped: QueryTimingSample[] = []
  for (const [name, sample] of Object.entries(current.queries)) {
    // Only the data-sufficiency filter here — the magnitude floor is applied by
    // `trendRegression` after the recent median, so one fast session can't drop a sustainably-regressed query.
    const currentSamples = comparableSamples(sample)
    if (currentSamples === null) { skipped.push(sample); continue }
    // ONE statement of which sessions carry a usable sample for this query,
    // read by both the comparison and the caveat below.
    const sampleIn = (r: InteractionComparable) => comparableSamples(r.queries[name])
    const measured = (r: InteractionComparable): number | null => sampleIn(r)?.p95Ms ?? null
    const recent = [currentSamples.p95Ms, ...recentPast.map(measured).filter((v): v is number => v !== null)]
    const baseline = baselineSessions.map(measured).filter((v): v is number => v !== null)
    const result = trendRegression(
      // The label says WHICH p95: this is the query measured with no queue to
      // be in, which is a smaller number than the wall-clock the same session
      // stores and than what a user waited. Reading one as the other is the
      // confusion the whole change exists to end.
      { metric: `query:${name}`, label: `${name} p95 (uncontended)`, unit: 'ms', minAbsolute: MIN_ABSOLUTE_MS },
      recent,
      baseline,
    )
    results.push(result)
    // Only a comparison that reached a verdict can be qualified: telling a
    // reader to distrust a trend that was never produced points at nothing.
    const consumed = [currentSamples, ...[...recentPast, ...baselineSessions].map(sampleIn)]
    if (result.status !== 'insufficient' &&
        consumed.some((q) => q !== null && hasClusteredTail(q))) {
      clusteredTail.push(name)
    }
  }
  // A query the comparison could not judge is exactly where a regression can
  // hide, so being unable to judge one has to SHOW. Dropped silently, a session
  // where one query is steady and three were unmeasurable reports a complete
  // clean comparison — and, because nothing is left awaiting a sample, stops
  // rechecking for the rest of the session.
  //
  // Whenever ANY current query is skipped, not only when every one was: the
  // all-skipped case is not the dangerous one. It is visibly empty. The
  // dangerous one is a judged query sitting beside an unjudged one, which looks
  // like an answer.
  //
  // One aggregate result rather than one per query — the reader's next move is
  // the same for all of them, and a result per skipped name would drown the
  // judged ones. WHICH aggregate, though: `never` is the stronger claim and is
  // made only when not one of the skipped queries holds a clean resolve;
  // otherwise they are still accumulating and this is an ordinary not-yet.
  if (skipped.length > 0) {
    const anyClean = skipped.some((q) => (q.uncontended?.calls ?? 0) > 0)
    results.push(anyClean ? NO_CURRENT_SAMPLE : NEVER_UNCONTENDED)
  }
  return {
    // Still empty means the session measured no queries at all — no names to
    // have skipped, so the branch above had nothing to report.
    results: results.length === 0 ? [NO_CURRENT_SAMPLE] : results,
    clusteredTail: clusteredTail.sort(),
  }
}

/** The costliest query in a session, by the p95 the comparison actually reads:
 *  the one measured with the DB connection pool free.
 *
 *  Lives HERE, beside `invalidationsPerWrite`, for that function's reason: a
 *  table charting a different number than the alarm fires on is worse than no
 *  table, and two definitions of "the slowest query" is how they would come to
 *  differ.
 *
 *  NOT the wall-clock p95 stored beside it, though that is the larger number
 *  and the one a user waited. Wall-clock on a busy pool is mostly the queue
 *  ahead of the caller, so it moves between sessions that behaved identically —
 *  a trend column swinging under a verdict that never moved. `null` where no
 *  query has a COMPARISON-ELIGIBLE sample — the same gate as the verdict, which
 *  a thin handful of clean resolves fails as surely as none at all. Either way
 *  nothing was judged, rather than nothing being slow. */
export const slowestQuery = (
  r: { queries: Record<string, QueryTimingSample> },
): { name: string; p95Ms: number } | null => {
  let worst: { name: string; p95Ms: number } | null = null
  for (const [name, q] of Object.entries(r.queries)) {
    // The comparison's OWN eligibility rule, not a looser presence check. A
    // query with one uncontended resolve would otherwise top the table on a
    // single 500ms outlier while the verdict compares a different,
    // well-sampled query — the table contradicting the alarm beside it.
    const p95Ms = comparableSamples(q)?.p95Ms
    if (p95Ms !== undefined && (!worst || p95Ms > worst.p95Ms)) worst = { name, p95Ms }
  }
  return worst
}

/** Handle invalidations per write — catches a bug latency can't see: an
 *  over-broad invalidation dep re-resolves on writes that don't concern it,
 *  so p95 never moves. `loaderInvalidations`, not `loaderRuns`, which a cold `load()` also bumps. */
export const invalidationsPerWrite = (r: InteractionComparable): number | null =>
  r.writes > 0 ? (r.fanout.loaderInvalidations ?? 0) / r.writes : null

export const fanoutRegression = (
  current: InteractionComparable,
  history: readonly InteractionComparable[],
): TrendResult => {
  const perWrite = invalidationsPerWrite
  const now = perWrite(current)
  // No writes means no rate to compare — a missing CURRENT sample, not short
  // history: more stored sessions can't supply this session's rate, though a live edit can.
  if (now === null) return NO_CURRENT_SAMPLE
  const rate = (rs: readonly InteractionComparable[]) =>
    rs.map(perWrite).filter((v): v is number => v !== null)
  return trendRegression(
    { metric: 'fanout:invalidationsPerWrite', label: 'handle invalidations per write', unit: 'ratio', minAbsolute: 0 },
    [now, ...rate(history.slice(0, RECENT_WINDOW - 1))],
    rate(baselineWindow(history)),
  )
}

/** Repo-ready → first paint. Isolated from `interactiveMs`: TTI also moves with sync volume and idle-herd contention, so this gap is noisier. */
export const bootstrapGapMs = (r: StartupRecordData): number | null =>
  r.firstContentPaintMs !== undefined && r.repoReadyMs !== undefined
    ? r.firstContentPaintMs - r.repoReadyMs
    : null

/** `series` is this device's PAST startup records, newest first — the window
 *  `loadSeriesWithCurrent` returns, which already excludes this boot's own row. */
export const startupRegression = (
  series: readonly StartupRecordData[],
  current: StartupRecordData | null,
): TrendResult => {
  const now = current === null ? null : bootstrapGapMs(current)
  // PRESENT AND USABLE, not merely present — a boot hidden until first paint
  // records via the fallback, leaving `bootstrapGapMs` null. An incomplete
  // row is immutable; an absent one may still be written late — neither means "still building".
  if (now === null) return NO_CURRENT_SAMPLE
  // Same shape as the interaction comparison: THIS session on the recent side,
  // and never in the baseline it is judged against. As a gate alone it would
  // report on the boots BEFORE this one — a slowdown starting now stays
  // invisible until enough later sessions have been recorded.
  const gaps = (rs: readonly StartupRecordData[]) =>
    rs.map(bootstrapGapMs).filter((v): v is number => v !== null)
  return trendRegression(
    { metric: 'startup:bootstrapGapMs', label: 'repo-ready to first paint', unit: 'ms', minAbsolute: MIN_ABSOLUTE_MS },
    [now, ...gaps(series.slice(0, RECENT_WINDOW - 1))],
    gaps(baselineWindow(series)),
  )
}
