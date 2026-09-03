// The latest performance analysis, so the status chip can react to it through
// the diagnostics seam.
//
// In-memory by design: the durable thing is the metrics SERIES (stored by the
// two recorders); this is only the current verdict about it, re-derived a
// minute into every session.
import { createWorkspaceSnapshotStore } from '@/utils/workspaceSnapshotStore.js'
import type { PerfAnalysis } from './analyze.js'
import { isCurrentRun, isCurrentRunOf } from './monitorRun.js'
import type { MetricsSpanSource } from '@/plugins/interaction-metrics/sessionContext.js'

/** Id of the global action that opens the trend view for the last analysis. */
export const VIEW_PERF_TREND_ACTION_ID = 'view_perf_trend'

const store = createWorkspaceSnapshotStore<PerfAnalysis>('perf-monitor-analysis')

/** Start order. A wall clock cannot order two runs starting in the same
 *  millisecond, and `analyzedAt` answers WHEN rather than which came first. */
let started = 0
export const nextAnalysisSeq = (): number => ++started

/** Publish, and say whether the store took it — the scheduler picks its next
 *  delay from that, and a refused analysis describes a run or a span that is
 *  gone. Refused when a later-started analysis already published: the cadenced
 *  pass and the manual refresh are not serialised. */
export const publishPerfAnalysis = (analysis: PerfAnalysis): boolean => {
  // A discarded Repo keeps its own `activeWorkspaceId` forever, so its analysis
  // resolves after a swap with every value it compares back still matching.
  if (!isCurrentRun(analysis.run)) return false
  const current = store.getFor(analysis.workspaceId)
  if (current && current.seq > analysis.seq) return false
  store.publish(analysis)
  return true
}

/** The verdict `repo` may show for `workspaceId`, or null.
 *
 *  Checked on the way OUT as well as in: readers take this during render, while
 *  the effect that clears the store runs after — leaving a commit that would
 *  paint the previous user's verdict. The caller's Repo decides rather than the
 *  run alone, because the run is module state that same reconciliation updates. */
export const getPerfAnalysisFor = (
  repo: MetricsSpanSource & object,
  workspaceId: string | null | undefined,
): PerfAnalysis | null => {
  const analysis = store.getFor(workspaceId)
  if (analysis === null || !isCurrentRunOf(analysis.run, repo)) return null
  // The SPAN too: `resetMetrics()` retires the counters a verdict rests on with
  // the Repo, workspace and run all unchanged. `onMetricsReset` wakes the
  // readers; this is what makes their re-read come back null.
  return analysis.epoch === repo.metricsSpan().epoch ? analysis : null
}
export const subscribePerfAnalysis = store.subscribe
/** The verdicts belong to a Repo; a swap invalidates them but not the chip
 *  subscribed to them. */
export const clearPerfAnalyses = store.clearSnapshots
export const resetPerfAnalysisStore = store.reset
