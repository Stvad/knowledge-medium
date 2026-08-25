// The latest performance analysis, so the status chip can react to it through
// the diagnostics seam.
//
// In-memory by design: the durable thing is the metrics SERIES (stored by the
// two recorders); this is only the current verdict about it, re-derived a
// minute into every session.
import { createWorkspaceSnapshotStore } from '@/utils/workspaceSnapshotStore.js'
import type { PerfAnalysis } from './analyze.js'

/** Id of the global action that opens the trend view for the last analysis. */
export const VIEW_PERF_TREND_ACTION_ID = 'view_perf_trend'

const store = createWorkspaceSnapshotStore<PerfAnalysis>('perf-monitor-analysis')

/** Publish, unless an analysis that started later has already published.
 *
 *  The cadenced pass and the trend view's manual refresh are not serialised —
 *  the manual path does not go through the job — so an older run resuming after
 *  its history reads would otherwise replace a fresher verdict, and the chip
 *  would carry it until the next scheduled pass. `analyzedAt` is stamped when a
 *  run STARTS, which is what makes it the right ordering key. */
export const publishPerfAnalysis = (analysis: PerfAnalysis): void => {
  const current = store.getFor(analysis.workspaceId)
  if (current && current.analyzedAt > analysis.analyzedAt) return
  store.publish(analysis)
}
export const getPerfAnalysisFor = store.getFor
export const subscribePerfAnalysis = store.subscribe
export const resetPerfAnalysisStore = store.reset
