/**
 * The comparison: is this session slower than this device's recent history?
 *
 * Everything here is pure. The judgement it encodes, and why:
 *
 * COMPARE A DEVICE AGAINST ITSELF. Absolute thresholds do not survive contact
 * with a fleet — a phone and a desktop disagree by more than any regression
 * does, and so do two graphs. The series is therefore per-client, and the
 * baseline is that client's own trailing median.
 *
 * A TREND, NOT A SESSION. One of the two regressions that motivated this
 * (#818) degraded gradually as the graph grew past the point where SQLite's
 * index stats made a wrong query plan look attractive. No single-session
 * threshold would ever have fired on it; only its own past does.
 *
 * MEDIAN, NOT MEAN. Sessions are wildly heterogeneous — a cold start, a big
 * sync, an open panel that mounts fifty handles. The mean tracks the outliers;
 * the median tracks the typical session, which is the thing a human means by
 * "it got slower".
 *
 * SMOOTH BOTH SIDES. "A trend, not a session" constrains the CURRENT side too:
 * read as a single session it fires on every anomalous boot, and an alarm that
 * cries wolf is worse than none. The current reading is therefore the median of
 * a small recent window, which costs a detection lag measured in sessions.
 */

import type { InteractionComparable } from '@/plugins/interaction-metrics/record.js'
import type { StartupRecordData } from '@/plugins/startup-metrics/record.js'

/** Sessions of history required before any comparison is reported. Below this
 *  the median is not a baseline, it is one arbitrary session with extra steps. */
export const MIN_BASELINE_SESSIONS = 5

/** How much worse than baseline counts as a regression. Deliberately coarse:
 *  this alarm exists to catch the 4x and the 140x, and a tighter ratio buys
 *  false positives from session heterogeneity rather than earlier warning. */
const REGRESSION_RATIO = 2

/** Below this, a query's p95 is not worth alarming on however much it grew —
 *  a 0.4ms query tripling is noise, not a regression a human can feel. */
const MIN_ABSOLUTE_MS = 5

/** Sessions smoothed into the "current" reading. Small on purpose: this is the
 *  detection LAG, in sessions, for a regression that just landed. Three is
 *  enough to outvote a single anomalous boot and still notice within a day. */
const RECENT_WINDOW = 3

/** Resolves needed before a query's p95 is treated as a measurement. */
const MIN_CALLS = 20

/** Sessions of stored history the interaction comparison needs before it can
 *  return anything: the baseline, plus the entries consumed smoothing the
 *  current reading. Exported so the "still building a baseline" state is
 *  derived from what the comparison requires rather than re-guessed. */
export const MIN_INTERACTION_HISTORY = MIN_BASELINE_SESSIONS + RECENT_WINDOW - 1

/** Same, for startup — where the current side is drawn entirely from stored
 *  records, so a full window is consumed rather than a window less one. */
export const MIN_STARTUP_HISTORY = MIN_BASELINE_SESSIONS + RECENT_WINDOW

/** The outcome of one comparison. `insufficient` is deliberately distinct from
 *  `steady`: "nothing was judged" and "everything was judged and is fine" are
 *  the same empty regression list but opposite statements, and collapsing them
 *  is how a monitor reports a clean bill of health for a comparison that never
 *  ran. Readiness is derived from these rather than from row counts, because a
 *  row that carries no usable sample is not history. */
export type TrendResult =
  | { status: 'insufficient' }
  | { status: 'steady' }
  | { status: 'regressed'; regression: Regression }

const INSUFFICIENT: TrendResult = { status: 'insufficient' }

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

const round2 = (n: number): number => Math.round(n * 100) / 100

/** Median of the recent window vs median of the baseline, or null if either
 *  side is too thin or the move is within tolerance. The one place the
 *  thresholds are applied, so every metric is judged on the same terms. */
const trendRegression = (
  spec: { metric: string; label: string; unit: 'ms' | 'ratio'; minAbsolute: number },
  recent: readonly number[],
  baseline: readonly number[],
): TrendResult => {
  // The recent side needs a FULL window, not merely a non-empty one: a caller
  // that could only measure this metric in the live session would otherwise
  // hand over a single sample, and the smoothing guarantee -- that one session
  // cannot swing a verdict -- would be silently void exactly when the history
  // is thinnest.
  if (recent.length < RECENT_WINDOW || baseline.length < MIN_BASELINE_SESSIONS) return INSUFFICIENT
  const current = median(recent.slice(0, RECENT_WINDOW))
  const base = median(baseline)
  // Judged, and too small to matter — a verdict, not a gap in the data.
  if (current < spec.minAbsolute) return { status: 'steady' }
  // A zero baseline admits no ratio, and the two reasons you can arrive at one
  // are opposite statements. Still zero: judged, and genuinely unchanged.
  // Zero before and something now: the metric moved from nothing to a value
  // that already cleared the floor above, and calling that `steady` would let
  // the chip certify an arbitrarily large regression as healthy — the one
  // outcome this feature exists to prevent. It is not a regression we can rate
  // either, since there is no ratio, so it is honestly reported as unjudged.
  if (base <= 0) return current === 0 ? { status: 'steady' } : INSUFFICIENT
  const ratio = current / base
  if (ratio < REGRESSION_RATIO) return { status: 'steady' }
  return {
    status: 'regressed',
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

/** A series is READY when at least one of its metrics could actually be
 *  judged. Row count alone is not readiness: records with no writes, or startup
 *  records missing their paint marks, are rows that carry no usable sample. */
export const anyJudged = (results: readonly TrendResult[]): boolean =>
  results.some((r) => r.status !== 'insufficient')

/** The regressions among these results, worst ratio first. The single place
 *  ordering is decided, so no caller has to re-sort and none can disagree. */
export const regressionsIn = (results: readonly TrendResult[]): Regression[] =>
  results
    .flatMap((r) => (r.status === 'regressed' ? [r.regression] : []))
    .sort((a, b) => b.ratio - a.ratio)

/** Per-query p95 regressions, worst ratio first. A query absent from the
 *  baseline is skipped rather than treated as infinitely regressed: a newly
 *  mounted surface is not a regression, and reporting it as one is how an
 *  alarm trains its reader to ignore it.
 *
 *  `recentPast` is the sessions between the live one and the baseline; they
 *  smooth the current reading (see the module docblock). */
export const queryRegressions = (
  current: InteractionComparable,
  history: readonly InteractionComparable[],
): TrendResult[] => {
  const recentPast = history.slice(0, RECENT_WINDOW - 1)
  const baselineSessions = history.slice(RECENT_WINDOW - 1)
  const out: TrendResult[] = []
  for (const [name, sample] of Object.entries(current.queries)) {
    // Not enough resolves to have a distribution, or too fast to feel: this
    // query contributes nothing to the verdict either way.
    if (sample.calls < MIN_CALLS || sample.p95Ms < MIN_ABSOLUTE_MS) continue
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
  return out
}

/** Handle invalidations per write.
 *
 *  This is the metric that catches the class of bug latency metrics cannot see:
 *  a query wired to an over-broad invalidation dep re-resolves on writes that
 *  do not concern it. Every individual resolve stays perfectly fast, so p95
 *  never moves — there are simply many times more of them.
 *
 *  `loaderInvalidations`, not `loaderRuns`: a cold `load()` from `subscribe()`
 *  bumps `loaderRuns` too, so that counter charges ordinary mounting and
 *  navigation to write fan-out. Measured on a real session, `loaderRuns` ran
 *  10× `loaderInvalidations` — a session that browsed more than it wrote would
 *  have read as regressed. */
export const invalidationsPerWrite = (r: InteractionComparable): number | null =>
  r.writes > 0 ? (r.fanout.loaderInvalidations ?? 0) / r.writes : null

export const fanoutRegression = (
  current: InteractionComparable,
  history: readonly InteractionComparable[],
): TrendResult => {
  const perWrite = invalidationsPerWrite
  const now = perWrite(current)
  // A session that has not written has no rate to compare, which is a gap in
  // the data rather than a clean result.
  if (now === null) return INSUFFICIENT
  const rate = (rs: readonly InteractionComparable[]) =>
    rs.map(perWrite).filter((v): v is number => v !== null)
  return trendRegression(
    { metric: 'fanout:invalidationsPerWrite', label: 'handle invalidations per write', unit: 'ratio', minAbsolute: 0 },
    [now, ...rate(history.slice(0, RECENT_WINDOW - 1))],
    rate(history.slice(RECENT_WINDOW - 1)),
  )
}

/** Repo-ready → first paint. Isolated from `interactiveMs` on purpose: TTI also
 *  moves with sync volume and idle-herd contention, so it is far noisier across
 *  sessions, while this gap is the bootstrap's own serialized work. */
export const bootstrapGapMs = (r: StartupRecordData): number | null =>
  r.firstContentPaintMs !== undefined && r.repoReadyMs !== undefined
    ? r.firstContentPaintMs - r.repoReadyMs
    : null

/** `series` is this device's startup records, NEWEST FIRST — the shape
 *  `loadRecords` returns. Takes the whole series rather than a current/baseline
 *  split because both sides are windows over it.
 *
 *  `currentTimeOriginMs` is this page session's `performance.timeOrigin`. The
 *  newest stored records are NOT necessarily from this boot — the write can
 *  fail, the recorder can be disabled or read-only, and the analysis can simply
 *  run before it. Comparing without one would republish a verdict from earlier
 *  page loads as though it described this one. */
export const startupRegression = (
  series: readonly StartupRecordData[],
  currentTimeOriginMs: number,
): TrendResult => {
  // Inside the recent WINDOW, not merely somewhere in the series. Presence
  // alone only implies currency via the sort order, and a backwards clock
  // correction between boots sinks this boot's record below older ones — the
  // guard would still pass while the window described earlier page loads.
  if (!series.slice(0, RECENT_WINDOW).some((r) => r.timeOriginMs === currentTimeOriginMs)) {
    return INSUFFICIENT
  }
  const gaps = (rs: readonly StartupRecordData[]) =>
    rs.map(bootstrapGapMs).filter((v): v is number => v !== null)
  return trendRegression(
    { metric: 'startup:bootstrapGapMs', label: 'repo-ready to first paint', unit: 'ms', minAbsolute: MIN_ABSOLUTE_MS },
    gaps(series.slice(0, RECENT_WINDOW)),
    gaps(series.slice(RECENT_WINDOW)),
  )
}
