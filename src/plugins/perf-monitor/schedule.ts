/**
 * Cadenced scheduling for the performance analysis, on the same terms as the
 * recorder: genuine idle only, never near boot.
 */
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import type { Repo } from '@/data/repo'
import { LAZY_DEEP_IDLE } from '@/utils/scheduleIdle.js'
import { MAX_BOOT_RECORD_MS, whenBootRecordSettled } from '@/plugins/startup-metrics/record.js'
import { cadencedIdleJob } from '@/utils/cadencedIdleJob.js'
import { contextHolds, metricsContext, observeWorkspace } from '@/plugins/interaction-metrics/sessionContext.js'
import { runPerfAnalysis } from './analyze.js'
import { clearPerfAnalyses, publishPerfAnalysis } from './store.js'
import { currentMonitorRun, endMonitorRun, startMonitorRun } from './monitorRun.js'

/** Wall clock between analyses. Long: the series it reads only gains a point
 *  per session, and re-deriving the same verdict is pure cost. Short enough
 *  that a regression developing mid-session is still noticed. */
const REANALYZE_MS = 10 * 60_000

/** How long to wait on the startup recorder before analyzing anyway.
 *
 *  A cap, not a schedule: the wait ends the moment that recorder settles — on a
 *  record, on running out of retries, or on declining to arm at all. This only
 *  bounds the case where its plugin never starts, where nothing settles.
 *
 *  Sized from the writer's own worst case rather than a number chosen here, so
 *  the cap cannot fall behind its retry schedule. Sampling the startup series
 *  early reads a working recorder as an absent one. */
const BOOT_RECORD_WAIT_MS = MAX_BOOT_RECORD_MS

const job = cadencedIdleJob({
  firstDelayMs: LAZY_DEEP_IDLE.minDelayMs,
  repeatDelayMs: REANALYZE_MS,
  label: 'perf-monitor',
})

/** Run now, publish, return. Used by the effect and by the trend view's manual
 *  refresh. Throws on failure so a caller can surface it. */
export const runPerfAnalysisNow = async (repo: Repo, workspaceId: string) => {
  // Both captured BEFORE the awaits. The analysis draws on AMBIENT state — the
  // live counters are page-global — and its history reads plus `countLiveBlocks`
  // are long enough for the world to move under it.
  //
  // TWO things, and neither implies the other:
  //
  //  - the RUN this belongs to, stamped onto the analysis so the store can
  //    refuse it at publication AND at every later read. Captured rather than
  //    read back at the end, or a refresh issued after teardown would adopt
  //    whatever run started next.
  //  - the counter SPAN, which no run change accompanies: a `resetMetrics()`
  //    mid-analysis retires the counters the verdict rests on while the Repo,
  //    the workspace and the run are all unchanged.
  //
  // The caller still gets the result; only the store is spared it.
  const run = currentMonitorRun()
  const ctx = metricsContext(repo, workspaceId)
  const analysis = { ...await runPerfAnalysis(repo, workspaceId, Date.now()), run }
  if (contextHolds(ctx, repo)) publishPerfAnalysis(analysis)
  return analysis
}

export const perfAnalysisEffect: AppEffect = {
  id: 'perf-monitor.analyze',
  start: ({ repo, workspaceId }) => {
    if (!workspaceId) return
    // A fresh run: every verdict from the previous one is already unreadable by
    // identity. This drops them and tells subscribers to re-read — NOT the
    // store's `reset`, which also drops the LISTENERS, and a
    // `useSyncExternalStore` subscriber never comes back from that: it
    // re-subscribes only when the `subscribe` identity changes, and this one is
    // module-stable.
    const run = startMonitorRun(repo, workspaceId)
    clearPerfAnalyses()
    observeWorkspace(repo, workspaceId)
    // No special case for an environment that can never record. The ordinary
    // pass reaches the same verdict there — without a durable client id the
    // reader derives a fresh group id every load, so both series come back
    // empty, nothing is judged, and `recordingBlockedBy` carries the reason —
    // and it costs two index-hit queries that return nothing. A hand-built
    // analysis for that one state was a second constructor for every field of
    // `PerfAnalysis`, kept in step by hand, to show the same words one idle
    // delay sooner.
    const stopJob = job.start(async () => {
      // Resolved already on every pass after the first, so this is a microtask
      // rather than a wait — it exists for the boot, where sampling the startup
      // series before its record lands misreports a recorder that is working.
      await whenBootRecordSettled(BOOT_RECORD_WAIT_MS)
      await runPerfAnalysisNow(repo, workspaceId)
    })
    return () => {
      // Teardown is not a pause. This effect goes away when the monitor's own
      // toggle is switched off, and the counters its verdicts describe keep
      // moving while it is gone — the always-on observer can make them
      // unattributable in the meantime, so what is cached stops being true and
      // nothing here would notice.
      //
      // Ending the run is what makes that true: an analysis still in flight
      // cannot publish afterwards, a refresh issued while the monitor is off
      // cannot either, and nothing can read what was published before. The
      // clear is housekeeping on top — it frees the snapshots and tells
      // subscribers to re-read.
      endMonitorRun(run)
      clearPerfAnalyses()
      stopJob()
    }
  },
}

export const perfAnalysisEffectContribution = appEffectsFacet.of(perfAnalysisEffect, {
  source: 'perf-monitor',
})
