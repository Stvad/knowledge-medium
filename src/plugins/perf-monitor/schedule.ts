/** Cadenced scheduling for the performance analysis: genuine idle only, never near boot. */
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import type { Repo } from '@/data/repo'
import { LAZY_DEEP_IDLE } from '@/utils/scheduleIdle.js'
import { cadencedIdleJob } from '@/utils/cadencedIdleJob.js'
import { contextHolds, metricsContext, observeWorkspace } from '@/plugins/interaction-metrics/sessionContext.js'
import { runPerfAnalysis, type PerfComparison } from './analyze.js'
import { clearPerfAnalyses, publishPerfAnalysis } from './store.js'
import { currentMonitorRun, endMonitorRun, hasMonitorRunFor, startMonitorRun } from './monitorRun.js'

/** Wall clock between analyses — long enough that re-deriving the same verdict is pure cost, short enough to still catch a mid-session regression. */
const REANALYZE_MS = 10 * 60_000

/** Retry interval when the last verdict awaited a sample that might still arrive —
 *  recorders retry on their own schedule, so this checks back sooner rather than sequencing against them. */
const RECHECK_MS = 60_000

/** Pure, and exported for it: sets how fast a wrong-looking verdict self-corrects.
 *  BACKOFF, not a deadline — neither series can tell "permanently missing" from "not
 *  yet written", so no deadline is safe; `waits` counts CONSECUTIVE preceding waits, so the first recheck is prompt. */
export const nextAnalysisDelayMs = (
  awaiting: { interaction: boolean; startup: boolean },
  waits: number,
): number => {
  if (!awaiting.interaction && !awaiting.startup) return REANALYZE_MS
  return Math.min(RECHECK_MS * 2 ** Math.max(0, waits), REANALYZE_MS)
}

const job = cadencedIdleJob({
  firstDelayMs: LAZY_DEEP_IDLE.minDelayMs,
  repeatDelayMs: REANALYZE_MS,
  label: 'perf-monitor',
})

/** Runs now, publishes, returns — used by the effect and the trend view's manual refresh; throws on failure so the caller can surface it. */
export const runPerfAnalysisNow = async (repo: Repo, workspaceId: string) => {
  // `run` and the counter span are captured BEFORE the awaits — ambient global state
  // can move under the read. `run` is stamped on the analysis (not read back at the end)
  // so a teardown/restart or sign-out mid-read can't stamp the wrong run; the span carries no such marker, so the store checks it separately.
  const run = hasMonitorRunFor(repo, workspaceId) ? currentMonitorRun() : null
  const ctx = metricsContext(repo, workspaceId)
  const analysis = { ...await runPerfAnalysis(repo, workspaceId, Date.now()), run }
  // ACCEPTED = the store holds it, the only claim a caller can act on — the store reports
  // its own answer (stale context / ended or foreign run / superseded) rather than this re-deriving it and drifting.
  const accepted = contextHolds(ctx, repo) && publishPerfAnalysis(analysis)
  return { analysis, accepted }
}

/** The running loop's re-arm hook, set while the loop is active, so an outside verdict (a manual refresh) resets a delay chosen before it existed.
 *  Origin is decided by WHICH FUNCTION the caller reached for (loop → `runPerfAnalysisNow`, everyone else → `refreshPerfAnalysis`), not by comparing
 *  values after the fact: `publishPerfAnalysis` notifies synchronously, so by the time of comparison even the loop's own pass would read as external. */
let rearmRunningLoop: ((analysis: PerfComparison) => void) | null = null

/** Runs an analysis on someone's behalf so the scheduled loop's cadence follows it too. */
export const refreshPerfAnalysis = async (repo: Repo, workspaceId: string) => {
  const result = await runPerfAnalysisNow(repo, workspaceId)
  // Only an ACCEPTED verdict sets the cadence — a refused one describes a span or run that's gone.
  if (result.accepted) rearmRunningLoop?.(result.analysis)
  return result
}

export const perfAnalysisEffect: AppEffect = {
  id: 'perf-monitor.analyze',
  start: ({ repo, workspaceId }) => {
    if (!workspaceId) return
    // Fresh run: previous verdicts are already unreadable by identity, so this clears them and tells subscribers to re-read — NOT the store's
    // `reset`, which also drops the LISTENERS; a `useSyncExternalStore` subscriber never comes back from that since `subscribe` is module-stable.
    const run = startMonitorRun(repo, workspaceId)
    clearPerfAnalyses()
    observeWorkspace(repo, workspaceId)
    // No special case for an environment that can't record — recorders refuse to write without a durable client id, so the ordinary pass already
    // reaches the same verdict (both series empty, `recordingBlockedBy` carries the reason) at the cost of two queries that return nothing.
    // Consecutive waits, for the backoff — advanced only on an ACCEPTED pass, since a refused one describes a span that's gone.
    let waits = 0
    /** The cadence for a verdict, applied identically whether the loop ran it or a refresh did, so the two can't disagree. */
    const cadenceFor = (analysis: PerfComparison): number => {
      const { interaction, startup } = analysis.awaitingLiveSample
      const delay = nextAnalysisDelayMs(analysis.awaitingLiveSample, waits)
      waits = interaction || startup ? waits + 1 : 0
      return delay
    }
    const loop = job.start(
      async () => {
        const { analysis, accepted } = await runPerfAnalysisNow(repo, workspaceId)
        // A refused result describes a gone span, so it says nothing about what the CURRENT one awaits — come back soon instead of adopting it.
        if (!accepted) return RECHECK_MS
        // ACCEPTED: a manual refresh may have already re-armed while this pass was in flight, so this delay yields to that (seconds-older) verdict.
        return cadenceFor(analysis)
      },
      // A throw produced no verdict — retry soon rather than on the full cadence, or a transient DB failure silences the monitor for ten minutes.
      { onFailureDelayMs: RECHECK_MS },
    )
    rearmRunningLoop = (analysis) => { loop.rearmIn(cadenceFor(analysis)) }
    // A reset opens a fresh span the loop never hears about — left on the ordinary cadence it'd leave the chip empty, so back off afresh instead.
    const stopWatchingReset = repo.onMetricsReset(() => {
      waits = 0
      loop.rearmIn(RECHECK_MS)
    })
    return () => {
      // Teardown is not a pause: counters keep moving while the effect is off, so a cached verdict silently goes stale. Ending the run (not just
      // stopping the loop) is what prevents that from mattering — nothing in flight or issued while off can publish, and nothing can read past it.
      endMonitorRun(run)
      stopWatchingReset()
      rearmRunningLoop = null
      clearPerfAnalyses()
      loop.stop()
    }
  },
}

export const perfAnalysisEffectContribution = appEffectsFacet.of(perfAnalysisEffect, {
  source: 'perf-monitor',
})
