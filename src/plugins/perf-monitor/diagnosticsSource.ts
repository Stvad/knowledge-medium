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
import { formatRegression, summarize, type LiveFacts } from './verdict.js'
import { recordingBlockedBy, type MetricsSpanSource } from '@/plugins/interaction-metrics/sessionContext.js'
import { getPerfAnalysisFor, subscribePerfAnalysis, VIEW_PERF_TREND_ACTION_ID } from './store.js'

export const mapAnalysisToSnapshot = (
  analysis: PerfAnalysis,
  live: LiveFacts,
): DiagnosticSnapshot => {
  const verdict = summarize(analysis, live)
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
  // `MetricsSpanSource` rather than `Pick<Repo, 'metrics'>`: the minimal shape
  // is what a caller has to satisfy, and a real Repo returns a superset of it.
  repo: Pick<Repo, 'activeWorkspaceId' | 'isReadOnly' | 'onReadOnlyChange' | 'onMetricsReset'>
    & MetricsSpanSource,
): DiagnosticSourceContribution => {
  let cachedKey = ''
  let cachedSnapshot: DiagnosticSnapshot | null = null
  return {
    id: 'perf-monitor',
    label: 'Performance',
    // BOTH, because the snapshot rests on both. A role change moves
    // `isReadOnly` and publishes no analysis, and a cache key cannot make
    // `useSyncExternalStore` call the getter — only a notification can — so
    // without this the chip keeps the pre-change message until something
    // unrelated re-renders it.
    subscribe: (listener) => {
      // The metrics reset too: it retires the counters a verdict rests on and
      // moves nothing else, so a reader with no other reason to re-read keeps
      // showing a verdict about figures that are gone.
      const stops = [
        subscribePerfAnalysis(listener),
        repo.onReadOnlyChange(listener),
        repo.onMetricsReset(listener),
      ]
      return () => { for (const stop of stops) stop() }
    },
    getSnapshot: () => {
      const analysis = getPerfAnalysisFor(repo, repo.activeWorkspaceId)
      // Read now, not taken off the analysis: a role change flips this without
      // republishing anything, and a stored answer would keep claiming
      // recording works until the next cadence.
      const live: LiveFacts = { blockedBy: recordingBlockedBy(repo) }
      // Keyed on the publication, not on a summary of it: two analyses can
      // share a timestamp and a regression count while differing in readiness,
      // baselines or values, and the cache would then hand back the old
      // snapshot while the trend view showed the new analysis. `seq` is unique
      // per run by construction. The live facts join the key for the same
      // reason — they change with no new publication behind them.
      const key = analysis
        ? `${analysis.workspaceId}:${analysis.seq}:${live.blockedBy ?? ''}`
        : `none:${repo.activeWorkspaceId ?? ''}:${live.blockedBy ?? ''}`
      if (key !== cachedKey) {
        cachedKey = key
        cachedSnapshot = analysis ? mapAnalysisToSnapshot(analysis, live) : null
      }
      return cachedSnapshot
    },
  }
}
