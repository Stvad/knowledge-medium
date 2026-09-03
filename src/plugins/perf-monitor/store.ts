// The latest performance analysis, so the status chip can react to it through
// the diagnostics seam.
//
// In-memory by design: the durable thing is the metrics SERIES (stored by the
// two recorders); this is only the current verdict about it, re-derived a
// minute into every session.
import { createWorkspaceSnapshotStore } from '@/utils/workspaceSnapshotStore.js'
import type { PerfAnalysis } from './analyze.js'
import { isCurrentRun } from './monitorRun.js'
import type { MetricsSpanSource } from '@/plugins/interaction-metrics/sessionContext.js'

/** Id of the global action that opens the trend view for the last analysis. */
export const VIEW_PERF_TREND_ACTION_ID = 'view_perf_trend'

const store = createWorkspaceSnapshotStore<PerfAnalysis>('perf-monitor-analysis')

/** Sequence number for the run order. A wall clock cannot order two runs that
 *  START in the same millisecond, and `Date.now()` is what `analyzedAt` is for
 *  — reporting WHEN, not which came first. Those are different jobs. */
let started = 0
export const nextAnalysisSeq = (): number => ++started

/** Publish, unless an analysis that started later has already published.
 *
 *  The cadenced pass and the trend view's manual refresh are not serialised —
 *  the manual path does not go through the job — so an older run resuming after
 *  its history reads would otherwise replace a fresher verdict, and the chip
 *  would carry it until the next scheduled pass. */
/** Publish, and say whether the store took it. The answer is the caller's
 *  only honest basis for treating the verdict as describing the current state
 *  — the scheduler picks its next delay from it, and a refused analysis
 *  describes a span or a run that is gone. */
export const publishPerfAnalysis = (analysis: PerfAnalysis): boolean => {
  // The run that produced it must still be the current one. A discarded Repo
  // keeps its own `activeWorkspaceId` forever, so its analysis resolves after a
  // swap with its pin intact and every value it compares back still matching.
  if (!isCurrentRun(analysis.run)) return false
  const current = store.getFor(analysis.workspaceId)
  if (current && current.seq > analysis.seq) return false
  store.publish(analysis)
  return true
}

/** The verdict `repo` may show for `workspaceId`, or null.
 *
 *  Checked on the way out, not only on the way in: both readers take this
 *  synchronously during render, and the effect that clears the store on a Repo
 *  swap is a passive one that runs after. Between those two there is a commit
 *  that would otherwise paint the previous user's verdict.
 *
 *  Which is also why the READER's Repo decides, rather than the run alone. The
 *  run is module state that the same passive reconciliation updates, so during
 *  that intervening render it still names the Repo being replaced — and a
 *  sign-out that keeps the workspace id would pass a check made only against
 *  it. The caller's Repo is current at render by construction. */
export const getPerfAnalysisFor = (
  repo: MetricsSpanSource & object,
  workspaceId: string | null | undefined,
): PerfAnalysis | null => {
  const analysis = store.getFor(workspaceId)
  if (analysis === null || analysis.run?.repo !== repo || !isCurrentRun(analysis.run)) return null
  // The SPAN too: `resetMetrics()` retires the counters a verdict rests on
  // while the Repo, the workspace and the run are all unchanged. Both readers
  // are woken by `onMetricsReset`, so what this adds is the ANSWER that wake-up
  // needs — the re-read it triggers has to come back null, and only the epoch
  // says so. Dropping it would leave the notification re-rendering the same
  // stale verdict.
  return analysis.epoch === repo.metricsSpan().epoch ? analysis : null
}
export const subscribePerfAnalysis = store.subscribe
/** The verdicts belong to a Repo; a swap invalidates them but not the chip
 *  subscribed to them. */
export const clearPerfAnalyses = store.clearSnapshots
export const resetPerfAnalysisStore = store.reset
