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
      detail: `Compared against ${analysis.baselineSessions} recent sessions`,
      actionId: VIEW_PERF_TREND_ACTION_ID,
      actionLabel: 'View trend',
    }
  }
  const worst = analysis.regressions[0]
  const rest = analysis.regressions.length - 1
  return {
    severity: 'warning',
    summary: `${worst.label} ${worst.ratio}× slower than baseline`,
    detail: analysis.regressions.slice(0, 3).map(formatRegression).join(' · ') +
      (rest > 2 ? ` · +${rest - 2} more` : ''),
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
