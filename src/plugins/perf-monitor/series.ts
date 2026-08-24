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
): Regression | null => {
  if (recent.length === 0 || baseline.length < MIN_BASELINE_SESSIONS) return null
  const current = median(recent.slice(0, RECENT_WINDOW))
  const base = median(baseline)
  if (current < spec.minAbsolute) return null
  const ratio = base === 0 ? Infinity : current / base
  if (ratio < REGRESSION_RATIO) return null
  return {
    metric: spec.metric,
    label: spec.label,
    baseline: round2(base),
    current: round2(current),
    ratio: round2(ratio),
    unit: spec.unit,
  }
}

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
): Regression[] => {
  const recentPast = history.slice(0, RECENT_WINDOW - 1)
  const baselineSessions = history.slice(RECENT_WINDOW - 1)
  const out: Regression[] = []
  for (const [name, sample] of Object.entries(current.queries)) {
    if (sample.calls < MIN_CALLS || sample.p95Ms < MIN_ABSOLUTE_MS) continue
    const measured = (r: InteractionComparable): number | null => {
      const q = r.queries[name]
      return q !== undefined && q.calls >= MIN_CALLS ? q.p95Ms : null
    }
    const recent = [sample.p95Ms, ...recentPast.map(measured).filter((v): v is number => v !== null)]
    const baseline = baselineSessions.map(measured).filter((v): v is number => v !== null)
    const found = trendRegression(
      { metric: `query:${name}`, label: `${name} p95`, unit: 'ms', minAbsolute: MIN_ABSOLUTE_MS },
      recent,
      baseline,
    )
    if (found) out.push(found)
  }
  return out.sort((a, b) => b.ratio - a.ratio)
}

/** Loader re-resolves per write.
 *
 *  This is the metric that catches the class of bug latency metrics cannot see:
 *  a query wired to an over-broad invalidation dep re-resolves on writes that
 *  do not concern it. Every individual resolve stays perfectly fast, so p95
 *  never moves — there are simply many times more of them. */
export const fanoutRegression = (
  current: InteractionComparable,
  history: readonly InteractionComparable[],
): Regression | null => {
  const perWrite = (r: InteractionComparable): number | null =>
    r.writes > 0 ? (r.fanout.loaderRuns ?? 0) / r.writes : null
  const now = perWrite(current)
  if (now === null) return null
  const rate = (rs: readonly InteractionComparable[]) =>
    rs.map(perWrite).filter((v): v is number => v !== null)
  return trendRegression(
    { metric: 'fanout:loaderRunsPerWrite', label: 'query re-resolves per write', unit: 'ratio', minAbsolute: 0 },
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
 *  split because both sides are windows over it. */
export const startupRegression = (
  series: readonly StartupRecordData[],
): Regression | null => {
  const gaps = (rs: readonly StartupRecordData[]) =>
    rs.map(bootstrapGapMs).filter((v): v is number => v !== null)
  return trendRegression(
    { metric: 'startup:bootstrapGapMs', label: 'repo-ready to first paint', unit: 'ms', minAbsolute: MIN_ABSOLUTE_MS },
    gaps(series.slice(0, RECENT_WINDOW)),
    gaps(series.slice(RECENT_WINDOW)),
  )
}
