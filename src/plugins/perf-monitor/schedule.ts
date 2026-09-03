/**
 * Cadenced scheduling for the performance analysis, on the same terms as the
 * recorder: genuine idle only, never near boot.
 */
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import type { Repo } from '@/data/repo'
import { LAZY_DEEP_IDLE } from '@/utils/scheduleIdle.js'
import { cadencedIdleJob } from '@/utils/cadencedIdleJob.js'
import { contextHolds, metricsContext, observeWorkspace } from '@/plugins/interaction-metrics/sessionContext.js'
import { runPerfAnalysis } from './analyze.js'
import { clearPerfAnalyses, publishPerfAnalysis } from './store.js'
import { currentMonitorRun, endMonitorRun, hasMonitorRunFor, startMonitorRun } from './monitorRun.js'

/** Wall clock between analyses. Long: the series it reads only gains a point
 *  per session, and re-deriving the same verdict is pure cost. Short enough
 *  that a regression developing mid-session is still noticed. */
const REANALYZE_MS = 10 * 60_000

/** How soon to look again when the last verdict was waiting on a sample that
 *  may still be on its way, and how long that stays plausible.
 *
 *  A boot record is written on the recorder's own idle schedule and can retry,
 *  so an analysis early in a page session can genuinely precede it. Rather than
 *  sequence the two — which couples this plugin to the internals of another,
 *  and has to stay correct across that writer's whole retry schedule — the
 *  reader simply comes back sooner while the answer might change, and any
 *  transient cause resolves within the minute rather than the cadence.
 *
 *  Bounded by the page's own age, not a counter: past the window, a missing
 *  sample is not late, it is absent, and re-asking every minute for the rest of
 *  the session would be pure cost. */
const RECHECK_MS = 60_000
const RECHECK_WINDOW_MS = 10 * 60_000
/** Slower, because the thing being waited for has no deadline — see below. */
const LIVE_RECHECK_MS = 3 * 60_000

/** Pure, and exported for it: this decides how quickly a wrong-looking verdict
 *  corrects itself, which is the whole behaviour a shorter cadence buys.
 *
 *  The two series are bounded differently BECAUSE their missing samples are
 *  different things. A startup record is written for this boot or it is not,
 *  and past the window it is not — page age is proof there. Interaction
 *  counters are live: a session that had written nothing when the pass ran
 *  becomes judgeable the moment someone edits, whenever that is, so page age
 *  proves nothing about them and the bound has to be cost instead. */
export const nextAnalysisDelayMs = (
  awaiting: { interaction: boolean; startup: boolean },
  pageAgeMs: number,
): number => {
  if (awaiting.startup && pageAgeMs < RECHECK_WINDOW_MS) return RECHECK_MS
  if (awaiting.interaction) return LIVE_RECHECK_MS
  return REANALYZE_MS
}

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
  //
  // The run has to be the one for THESE arguments, not merely whichever is in
  // force: a teardown-and-restart while this pass is reading history installs a
  // different one, and a sign-out that keeps the workspace id would otherwise
  // stamp the previous user's analysis with the new user's run.
  const run = hasMonitorRunFor(repo, workspaceId) ? currentMonitorRun() : null
  const ctx = metricsContext(repo, workspaceId)
  const analysis = { ...await runPerfAnalysis(repo, workspaceId, Date.now()), run }
  // ACCEPTED means the store holds it, which is the only claim a caller can
  // act on. Four things can refuse it — the context moving under this pass, a
  // run that ended, a run that was never ours, a newer analysis already
  // published — and the scheduler must not set its cadence from any of them.
  // Three of those live in the store, so the store reports its own answer
  // rather than the two halves being re-derived here and drifting.
  const accepted = contextHolds(ctx, repo) && publishPerfAnalysis(analysis)
  return { analysis, accepted }
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
    const stopJob = job.start(
      async () => {
        const { analysis, accepted } = await runPerfAnalysisNow(repo, workspaceId)
        // A refused result describes a span that no longer exists, so it says
        // nothing about what the CURRENT one is waiting for. Come back soon
        // instead of adopting its answer — the state that made it stale (a
        // reset, a workspace switch) is exactly when a fresh verdict matters.
        if (!accepted) return RECHECK_MS
        return nextAnalysisDelayMs(analysis.awaitingLiveSample, performance.now())
      },
      // A pass that threw produced no verdict at all. Retrying on the full
      // cadence would leave the monitor silent for ten minutes over a
      // transient DB failure, which is the state it is least useful in.
      { onFailureDelayMs: RECHECK_MS },
    )
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
