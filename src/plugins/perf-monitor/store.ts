// In-memory observable for the latest performance analysis, so the status chip
// can react to it through the diagnostics seam. Framework-agnostic and
// kernel-safe, mirroring `@/plugins/data-integrity/store`.
//
// In-memory by design: the durable thing is the metrics SERIES (stored by the
// two recorders); this is only the current verdict about it, re-derived a
// minute into every session.
import { CallbackSet } from '@/utils/callbackSet.js'
import type { PerfAnalysis } from './analyze.js'

/** Id of the global action that opens the trend view for the last analysis. */
export const VIEW_PERF_TREND_ACTION_ID = 'view_perf_trend'

// Per workspace, so an analysis for one cannot blank a dialog open on another.
const byWorkspace = new Map<string, PerfAnalysis>()
const listeners = new CallbackSet('perf-monitor-analysis')

export const publishPerfAnalysis = (analysis: PerfAnalysis): void => {
  byWorkspace.set(analysis.workspaceId, analysis)
  listeners.notify()
}

export const getPerfAnalysisFor = (
  workspaceId: string | null | undefined,
): PerfAnalysis | null =>
  (workspaceId != null ? byWorkspace.get(workspaceId) : undefined) ?? null

export const subscribePerfAnalysis = (listener: () => void): (() => void) =>
  listeners.add(listener)

/** Test helper — clear published analyses + listeners. */
export const resetPerfAnalysisStore = (): void => {
  byWorkspace.clear()
  listeners.clear()
}
