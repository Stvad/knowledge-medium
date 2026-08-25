/**
 * The performance monitor's contribution to the diagnostics seam.
 *
 * Severity tops out at `warning`, never `error`: an `error` reddens the whole
 * status chip, which is the app's signal for "your data is structurally wrong".
 * A slow query is worth a nudge and no more, and spending the loud channel on
 * it would devalue the loud channel.
 */
import type { Repo } from '@/data/repo'
import type {
  DiagnosticSnapshot,
  DiagnosticSourceContribution,
} from '@/plugins/diagnostics/facet.js'
import type { PerfAnalysis } from './analyze.js'
import { getPerfAnalysisFor, subscribePerfAnalysis, VIEW_PERF_TREND_ACTION_ID } from './store.js'

const formatRegression = (r: { label: string; baseline: number; current: number; unit: string }): string =>
  r.unit === 'ms'
    ? `${r.label} ${Math.round(r.baseline)}ms → ${Math.round(r.current)}ms`
    : `${r.label} ${r.baseline} → ${r.current}`

/** Why the graph size is reported and not corrected for: see `runPerfAnalysis`.
 *  Shown only once it has actually moved, so the common case stays quiet. */
const graphNote = (growth: number | null): string | null =>
  growth !== null && growth >= 1.05
    ? `graph ${Math.round((growth - 1) * 100)}% larger than the baseline's`
    : null

/** A comparison that could not run must not read as one that ran and found
 *  nothing — the whole point of this feature. Distinguishes the two reasons a
 *  series stays out of the verdict, because they resolve differently: waiting
 *  fixes one, and only a fresh page session fixes the other. */
const pendingNote = (analysis: PerfAnalysis): string | null => {
  if (!analysis.interactionComparable) {
    return 'interaction metrics not comparable this session (more than one workspace opened)'
  }
  if (!analysis.ready.interaction) return 'interaction history still building'
  if (!analysis.ready.startup) return 'startup history still building'
  return null
}

const joined = (...parts: Array<string | null>): string | undefined =>
  parts.filter((p): p is string => Boolean(p)).join(' · ') || undefined

export const mapAnalysisToSnapshot = (analysis: PerfAnalysis): DiagnosticSnapshot => {
  // Too little history is reported as its own state rather than as health: a
  // silent "ok" from a comparison that never ran is the failure mode this whole
  // feature exists to remove.
  if (analysis.insufficientHistory) {
    return {
      severity: 'info',
      summary: 'Building a baseline',
      detail: `${analysis.baselineSessions} of the sessions needed before trends are compared`,
      actionId: VIEW_PERF_TREND_ACTION_ID,
      actionLabel: 'View trend',
    }
  }
  if (analysis.regressions.length === 0) {
    return {
      severity: 'ok',
      summary: 'No slowdowns vs baseline',
      detail: joined(
        `Compared against ${analysis.baselineSessions} recent sessions`,
        pendingNote(analysis),
      ),
      actionId: VIEW_PERF_TREND_ACTION_ID,
      actionLabel: 'View trend',
    }
  }
  const worst = analysis.regressions[0]
  const rest = analysis.regressions.length - 1
  return {
    severity: 'warning',
    summary: `${worst.label} ${worst.ratio}× slower than baseline`,
    detail: joined(
      analysis.regressions.slice(0, 3).map(formatRegression).join(' · ') +
        (rest > 2 ? ` · +${rest - 2} more` : ''),
      graphNote(analysis.graphGrowth),
      pendingNote(analysis),
    ),
    actionId: VIEW_PERF_TREND_ACTION_ID,
    actionLabel: 'View trend',
    // A quiet dot rather than a red chip -- see the module docblock.
    nudge: true,
  }
}

export const createPerfMonitorDiagnosticSource = (
  repo: Pick<Repo, 'activeWorkspaceId'>,
): DiagnosticSourceContribution => {
  let cachedKey = ''
  let cachedSnapshot: DiagnosticSnapshot | null = null
  return {
    id: 'perf-monitor',
    label: 'Performance',
    subscribe: subscribePerfAnalysis,
    getSnapshot: () => {
      const analysis = getPerfAnalysisFor(repo.activeWorkspaceId)
      const key = analysis
        ? `${analysis.workspaceId}:${analysis.analyzedAt}:${analysis.regressions.length}`
        : `none:${repo.activeWorkspaceId ?? ''}`
      if (key !== cachedKey) {
        cachedKey = key
        cachedSnapshot = analysis ? mapAnalysisToSnapshot(analysis) : null
      }
      return cachedSnapshot
    },
  }
}
