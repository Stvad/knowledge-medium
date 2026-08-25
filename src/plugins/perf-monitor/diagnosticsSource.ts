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
import { formatRegression, summarize } from './verdict.js'
import { getPerfAnalysisFor, subscribePerfAnalysis, VIEW_PERF_TREND_ACTION_ID } from './store.js'

export const mapAnalysisToSnapshot = (analysis: PerfAnalysis): DiagnosticSnapshot => {
  const verdict = summarize(analysis)
  const detail = [
    ...(verdict.regressions.slice(0, 3).map(formatRegression)),
    ...(verdict.regressions.length > 3 ? [`+${verdict.regressions.length - 3} more`] : []),
    ...verdict.notes,
  ].join(' · ')
  return {
    // Tops out at `warning` with a quiet nudge -- see the module docblock.
    severity: verdict.kind === 'regressed' ? 'warning' : verdict.kind === 'pending' ? 'info' : 'ok',
    summary: verdict.headline,
    detail: detail || undefined,
    actionId: VIEW_PERF_TREND_ACTION_ID,
    actionLabel: 'View trend',
    ...(verdict.kind === 'regressed' ? { nudge: true } : {}),
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
