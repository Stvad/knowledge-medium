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

/** Wall clock between analyses. Long: the series it reads only gains a point
 *  per session, and re-deriving the same verdict is pure cost. Short enough
 *  that a regression developing mid-session is still noticed. */
const REANALYZE_MS = 10 * 60_000

const job = cadencedIdleJob({
  firstDelayMs: LAZY_DEEP_IDLE.minDelayMs,
  repeatDelayMs: REANALYZE_MS,
  label: 'perf-monitor',
})

/** Run now, publish, return. Used by the effect and by the trend view's manual
 *  refresh. Throws on failure so a caller can surface it. */
export const runPerfAnalysisNow = async (repo: Repo, workspaceId: string) => {
  // Captured BEFORE the awaits, compared after. The analysis draws on AMBIENT
  // state — `repo.isReadOnly` describes whichever workspace is active now, the
  // live counters are page-global — and its history reads plus `countLiveBlocks`
  // are long enough for the world to move under it.
  //
  // TWO things to check, and neither implies the other:
  //
  //  - the CONTEXT it was computed under must still describe the world: same
  //    Repo, same workspace, same counter span. The span is why this is not
  //    just a workspace comparison — a `resetMetrics()` mid-analysis retires
  //    the counters the verdict rests on while every other value is unchanged.
  //  - the GENERATION catches what comparing values back cannot. `A→B→A` during
  //    the awaits leaves the context equal to what it was while the analysis
  //    absorbed B's ambient state. The effect restarts on any of those changes,
  //    so one counter covers the ones a value comparison cannot see.
  //
  // The caller still gets the result; only the chip is spared it.
  const generation = contextGeneration
  const ctx = metricsContext(repo, workspaceId)
  const analysis = await runPerfAnalysis(repo, workspaceId, Date.now())
  const held = generation === contextGeneration && contextHolds(ctx, repo)
  if (held && ownsStore(repo, workspaceId)) publishPerfAnalysis(analysis)
  return analysis
}

/** The Repo AND workspace the published verdicts belong to.
 *
 *  The Repo because a local sign-out swaps it without a reload, and the store is
 *  keyed by workspace alone — so the next user opening the same shared workspace
 *  would be shown the previous user's verdict over their own client's history.
 *
 *  The workspace because the counters a verdict rests on are page-global: once
 *  the page has been in a second workspace they are no longer attributable to
 *  the first, so the verdict cached for it describes a comparison that would no
 *  longer be made. Blank until the next analysis is honest; stale is not. */
let publishedFor: { repo: object; workspaceId: string } | null = null

/** Bumped whenever the analysis context changes. The effect restarts on a Repo
 *  swap AND on a workspace change, so one counter covers both — and a run that
 *  started under an earlier value is describing a world that has moved on. */
let contextGeneration = 0

/** May `repo` publish into the store? Claims it when nobody has — the manual
 *  refresh is a standalone entry point and must work without the effect having
 *  run — so this only ever refuses a Repo that has been SUPERSEDED. That is the
 *  case worth refusing: a discarded Repo keeps its own `activeWorkspaceId`
 *  forever, so its run resolves after the swap, finds its pin intact, and would
 *  publish the previous user's verdict into the store the new one is reading. */
const ownsStore = (repo: object, workspaceId: string): boolean => {
  if (publishedFor === null) publishedFor = { repo, workspaceId }
  return publishedFor.repo === repo && publishedFor.workspaceId === workspaceId
}

/** Test helper — forget which context owns the store.
 *
 *  Module state with no reset seam made these tests order-dependent: a claim
 *  from whichever test ran first survived into the next, so a later test's
 *  "did not publish" could hold because publication was never possible there.
 *  A negative assertion that cannot distinguish those two is no assertion. */
export const resetPerfSchedulingState = (): void => { publishedFor = null }

export const perfAnalysisEffect: AppEffect = {
  id: 'perf-monitor.analyze',
  start: ({ repo, workspaceId }) => {
    if (!workspaceId) return
    contextGeneration++
    if (!ownsStore(repo, workspaceId)) {
      // NOT the store's `reset`: that drops the LISTENERS too, and a
      // `useSyncExternalStore` subscriber never comes back from it — it
      // re-subscribes only when the `subscribe` identity changes, and this one
      // is module-stable. The chip would hold the pre-swap verdict for the rest
      // of the session, deaf to every later publish.
      clearPerfAnalyses()
      publishedFor = { repo, workspaceId }
    }
    observeWorkspace(repo, workspaceId)
    // No special case for an environment that can never record. The ordinary
    // pass reaches the same verdict there — without a durable client id the
    // reader derives a fresh group id every load, so both series come back
    // empty, nothing is judged, and `recordingBlockedBy` carries the reason —
    // and it costs two index-hit queries that return nothing. A hand-built
    // analysis for that one state was a second constructor for every field of
    // `PerfAnalysis`, kept in step by hand, to show the same words one idle
    // delay sooner.
    const stopJob = job.start(async () => { await runPerfAnalysisNow(repo, workspaceId) })
    return () => {
      // Teardown is not a pause. This effect goes away when the monitor's own
      // toggle is switched off, and the counters its verdicts describe keep
      // moving while it is gone — the always-on observer can make them
      // unattributable in the meantime, so what is cached stops being true and
      // nothing here would notice.
      //
      // Two clauses, each load-bearing: the generation stops a run still in
      // flight from publishing afterwards, and the snapshots go now because
      // re-enabling in the same workspace still OWNS the store, so the
      // start-time clear would be skipped and the pre-teardown verdict shown.
      // Ownership itself is deliberately left alone — dropping it here changes
      // nothing once the snapshots are gone.
      contextGeneration++
      clearPerfAnalyses()
      stopJob()
    }
  },
}

export const perfAnalysisEffectContribution = appEffectsFacet.of(perfAnalysisEffect, {
  source: 'perf-monitor',
})
