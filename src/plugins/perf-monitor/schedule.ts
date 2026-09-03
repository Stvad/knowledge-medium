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
import { clearPerfAnalyses, getPerfAnalysisFor, publishPerfAnalysis, subscribePerfAnalysis } from './store.js'
import { currentMonitorRun, endMonitorRun, hasMonitorRunFor, startMonitorRun } from './monitorRun.js'

/** Wall clock between analyses. Long: the series it reads only gains a point
 *  per session, and re-deriving the same verdict is pure cost. Short enough
 *  that a regression developing mid-session is still noticed. */
const REANALYZE_MS = 10 * 60_000

/** How soon to look again when the last verdict was waiting on a sample that
 *  may still be on its way.
 *
 *  A record is written on its recorder's own idle schedule and can retry, so an
 *  analysis can genuinely precede it. Rather than sequence the two — which
 *  couples this plugin to the internals of another, and has to stay correct
 *  across that writer's whole retry schedule — the reader simply comes back
 *  sooner while the answer might change. */
const RECHECK_MS = 60_000

/** Pure, and exported for it: this decides how quickly a wrong-looking verdict
 *  corrects itself, which is the whole behaviour a shorter cadence buys.
 *
 *  BACKOFF, not a deadline. This used to bound the fast recheck two different
 *  ways — a page-age window for the startup series, a slower fixed interval for
 *  the interaction one — and both encoded a claim the reader cannot actually
 *  make: that a missing sample is now permanently missing. Neither held. A
 *  startup recorder switched on in an hour-old page still writes this boot's
 *  record, well past any page-age window; an interaction recorder that has not
 *  written YET is indistinguishable from one that is switched off, and calling
 *  it off is a guess that shows the user the wrong thing.
 *
 *  Backing off answers a question that can be answered — how much is another
 *  look worth — instead of one that cannot. A sample that arrives late is still
 *  picked up; a recorder that is genuinely off costs a handful of extra passes
 *  and then settles at the ordinary cadence, which is what it would have cost
 *  anyway. `waits` is the number of CONSECUTIVE preceding analyses that came
 *  back still waiting, so the first recheck is prompt. */
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
    // pass reaches the same verdict there: without a durable client id the
    // RECORDERS refuse to write at all (`no-persistent-client`), so both series
    // are empty, nothing is judged, and `recordingBlockedBy` carries the
    // reason — and it costs two index-hit queries that return nothing.
    //
    // The eligibility rule is what empties them, NOT the id moving: within a
    // page session `getClientId()` caches one fallback id, so the reader is
    // looking in a consistent place. There is nothing there to find. A hand-built
    // analysis for that one state was a second constructor for every field of
    // `PerfAnalysis`, kept in step by hand, to show the same words one idle
    // delay sooner.
    // Consecutive waits, for the backoff. Loop-local, and advanced only by a
    // pass whose result was ACCEPTED — a refused one describes a span that is
    // gone, and letting it count would back off over a verdict that never
    // applied.
    let waits = 0
    /** The last analysis this loop produced, so a publication from elsewhere
     *  can be told apart from its own. */
    let ownSeq = -1
    /** The cadence for a verdict, and the bookkeeping that goes with it —
     *  applied identically whether the loop ran it or the dialog's refresh did,
     *  so the two cannot disagree about how soon to look again. */
    const cadenceFor = (analysis: { seq: number; awaitingLiveSample: { interaction: boolean; startup: boolean } }): number => {
      const { interaction, startup } = analysis.awaitingLiveSample
      const delay = nextAnalysisDelayMs(analysis.awaitingLiveSample, waits)
      waits = interaction || startup ? waits + 1 : 0
      ownSeq = analysis.seq
      return delay
    }
    const loop = job.start(
      async () => {
        const { analysis, accepted } = await runPerfAnalysisNow(repo, workspaceId)
        // A refused result describes a span that no longer exists, so it says
        // nothing about what the CURRENT one is waiting for. Come back soon
        // instead of adopting its answer — the state that made it stale (a
        // reset, a workspace switch) is exactly when a fresh verdict matters.
        if (!accepted) return RECHECK_MS
        return cadenceFor(analysis)
      },
      // A pass that threw produced no verdict at all. Retrying on the full
      // cadence would leave the monitor silent for ten minutes over a
      // transient DB failure, which is the state it is least useful in.
      { onFailureDelayMs: RECHECK_MS },
    )
    // The trend dialog's refresh runs OUTSIDE this loop, so a verdict it
    // publishes leaves the loop sitting on a delay computed before that verdict
    // existed — a manual refresh revealing a missing sample would then be
    // followed by the full cadence, exactly when a prompt second look is what
    // was asked for. Re-arm on the same terms the loop's own run uses.
    const stopWatching = subscribePerfAnalysis(() => {
      const analysis = getPerfAnalysisFor(repo, workspaceId)
      // Only what this loop did not produce, and only what is still readable —
      // `getPerfAnalysisFor` re-checks the run and the counter span, so a
      // verdict the store would refuse cannot set the cadence here either.
      if (analysis === null || analysis.seq === ownSeq) return
      loop.rearmIn(cadenceFor(analysis))
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
      stopWatching()
      clearPerfAnalyses()
      loop.stop()
    }
  },
}

export const perfAnalysisEffectContribution = appEffectsFacet.of(perfAnalysisEffect, {
  source: 'perf-monitor',
})
