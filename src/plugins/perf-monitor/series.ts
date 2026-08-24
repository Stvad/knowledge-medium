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

const ratioOf = (current: number, baseline: number): number =>
  baseline === 0 ? Infinity : current / baseline

const round2 = (n: number): number => Math.round(n * 100) / 100

/** Per-query p95 regressions, worst ratio first. A query absent from the
 *  baseline is skipped rather than treated as infinitely regressed: a newly
 *  mounted surface is not a regression, and reporting it as one is how an
 *  alarm trains its reader to ignore it. */
export const queryRegressions = (
  current: InteractionComparable,
  baseline: readonly InteractionComparable[],
): Regression[] => {
  const out: Regression[] = []
  for (const [name, sample] of Object.entries(current.queries)) {
    if (sample.calls < MIN_CALLS || sample.p95Ms < MIN_ABSOLUTE_MS) continue
    const past = baseline
      .map((b) => b.queries[name])
      .filter((q): q is NonNullable<typeof q> => q !== undefined && q.calls >= MIN_CALLS)
    if (past.length < MIN_BASELINE_SESSIONS) continue
    const base = median(past.map((q) => q.p95Ms))
    const ratio = ratioOf(sample.p95Ms, base)
    if (ratio < REGRESSION_RATIO) continue
    out.push({
      metric: `query:${name}`,
      label: `${name} p95`,
      baseline: round2(base),
      current: round2(sample.p95Ms),
      ratio: round2(ratio),
      unit: 'ms',
    })
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
  baseline: readonly InteractionComparable[],
): Regression | null => {
  const perWrite = (r: InteractionComparable): number | null =>
    r.writes > 0 ? (r.fanout.loaderRuns ?? 0) / r.writes : null
  const now = perWrite(current)
  if (now === null) return null
  const past = baseline.map(perWrite).filter((v): v is number => v !== null)
  if (past.length < MIN_BASELINE_SESSIONS) return null
  const base = median(past)
  const ratio = ratioOf(now, base)
  if (ratio < REGRESSION_RATIO) return null
  return {
    metric: 'fanout:loaderRunsPerWrite',
    label: 'query re-resolves per write',
    baseline: round2(base),
    current: round2(now),
    ratio: round2(ratio),
    unit: 'ratio',
  }
}

/** Repo-ready → first paint. Isolated from `interactiveMs` on purpose: TTI
 *  moves with sync volume and idle-herd contention, so it is noisy across
 *  sessions, while this gap is the bootstrap's own serialized work and held
 *  within ~70ms for three weeks in the real series. It is the startup number
 *  worth alarming on. */
export const bootstrapGapMs = (r: StartupRecordData): number | null =>
  r.firstContentPaintMs !== undefined && r.repoReadyMs !== undefined
    ? r.firstContentPaintMs - r.repoReadyMs
    : null

export const startupRegression = (
  current: StartupRecordData,
  baseline: readonly StartupRecordData[],
): Regression | null => {
  const now = bootstrapGapMs(current)
  if (now === null) return null
  const past = baseline.map(bootstrapGapMs).filter((v): v is number => v !== null)
  if (past.length < MIN_BASELINE_SESSIONS) return null
  const base = median(past)
  const ratio = ratioOf(now, base)
  if (ratio < REGRESSION_RATIO || now < MIN_ABSOLUTE_MS) return null
  return {
    metric: 'startup:bootstrapGapMs',
    label: 'repo-ready to first paint',
    baseline: round2(base),
    current: round2(now),
    ratio: round2(ratio),
    unit: 'ms',
  }
}
