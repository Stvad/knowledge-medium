/**
 * Is this session slower than this device's recent history? Pure. Three
 * judgements: COMPARE A DEVICE AGAINST ITSELF (thresholds don't survive a
 * fleet); A TREND ON BOTH SIDES (a fixed number misses gradual regressions,
 * a single session fires on every anomaly); MEDIAN NOT MEAN (sessions are
 * heterogeneous; the median tracks the typical one).
 */
import type { InteractionComparable } from '@/plugins/interaction-metrics/record.js'
import type { StartupRecordData } from '@/plugins/startup-metrics/record.js'

/** Sessions of history required before any comparison is reported — below this the median is one arbitrary session with extra steps. */
export const MIN_BASELINE_SESSIONS = 5

/** How much worse than baseline counts as a regression — deliberately coarse, since tighter buys false positives from session noise, not earlier warning. */
const REGRESSION_RATIO = 2

/** Below this, a p95 isn't worth alarming on however much it grew — noise, not a regression a human can feel. */
const MIN_ABSOLUTE_MS = 5

/** Sessions smoothed into the "current" reading — the detection LAG for a just-landed regression, small enough to still notice within a day. */
const RECENT_WINDOW = 3

/** Resolves needed before a query's p95 is treated as a measurement. */
const MIN_CALLS = 20

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
  | { status: 'insufficient'; reason: 'history' | 'no-current-sample' | 'no-baseline' }
  /** `baselineCount` is sessions actually consumed, not rows loaded — rows with no usable sample are filtered out before the median. */
  | { status: 'steady'; baselineCount: number }
  | { status: 'regressed'; regression: Regression; baselineCount: number }

const INSUFFICIENT: TrendResult = { status: 'insufficient', reason: 'history' }
/** This session contributed no sample, so no amount of history helps. */
const NO_CURRENT_SAMPLE: TrendResult = { status: 'insufficient', reason: 'no-current-sample' }
/** History enough, and every session in it zero — there is no ratio to form. */
const NO_BASELINE: TrendResult = { status: 'insufficient', reason: 'no-baseline' }

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
 *  nothing to have been judged would stop it rechecking the unmeasured one. */
export const awaitingCurrentSample = (results: readonly TrendResult[]): boolean =>
  results.length > 0 &&
  results.some((r) => r.status === 'insufficient' && r.reason === 'no-current-sample')

/** Nothing judged, and at least one metric had a full but all-zero baseline —
 *  the gap waiting cannot close. `some`, like `awaitingCurrentSample`: it names
 *  the more specific reason where one exists. */
export const lacksBaseline = (results: readonly TrendResult[]): boolean =>
  results.some((r) => r.status === 'insufficient' && r.reason === 'no-baseline')

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

/** Per-query p95 regressions, worst ratio first. A query absent from the
 *  baseline is skipped, not infinitely regressed. `recentPast` smooths the current reading. */
export const queryRegressions = (
  current: InteractionComparable,
  history: readonly InteractionComparable[],
): TrendResult[] => {
  const recentPast = history.slice(0, RECENT_WINDOW - 1)
  const baselineSessions = baselineWindow(history)
  const out: TrendResult[] = []
  for (const [name, sample] of Object.entries(current.queries)) {
    // Only the data-sufficiency filter here — the magnitude floor is applied by
    // `trendRegression` after the recent median, so one fast session can't drop a sustainably-regressed query.
    if (sample.calls < MIN_CALLS) continue
    const measured = (r: InteractionComparable): number | null => {
      const q = r.queries[name]
      return q !== undefined && q.calls >= MIN_CALLS ? q.p95Ms : null
    }
    const recent = [sample.p95Ms, ...recentPast.map(measured).filter((v): v is number => v !== null)]
    const baseline = baselineSessions.map(measured).filter((v): v is number => v !== null)
    out.push(trendRegression(
      { metric: `query:${name}`, label: `${name} p95`, unit: 'ms', minAbsolute: MIN_ABSOLUTE_MS },
      recent,
      baseline,
    ))
  }
  // Nothing judged isn't nothing to say: an empty list would leave fan-out
  // alone in the series, reading as a clean bill nobody actually checked. One aggregate result, not one per skipped query.
  return out.length === 0 ? [NO_CURRENT_SAMPLE] : out
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
