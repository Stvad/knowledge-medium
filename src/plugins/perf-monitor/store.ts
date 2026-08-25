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

export const publishPerfAnalysis = store.publish
export const getPerfAnalysisFor = store.getFor
export const subscribePerfAnalysis = store.subscribe
export const resetPerfAnalysisStore = store.reset
