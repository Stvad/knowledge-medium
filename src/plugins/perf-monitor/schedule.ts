/**
 * Cadenced scheduling for the performance analysis, on the same terms as the
 * recorder: genuine idle only, never near boot.
 */
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import type { Repo } from '@/data/repo'
import { LAZY_DEEP_IDLE } from '@/utils/scheduleIdle.js'
import { cadencedIdleJob } from '@/utils/cadencedIdleJob.js'
import { observeWorkspace } from '@/plugins/interaction-metrics/sessionContext.js'
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
  // Stamped BEFORE the awaits, compared after. The analysis draws on AMBIENT
  // state — `repo.isReadOnly` describes whichever workspace is active now, the
  // live counters are page-global — and its history reads plus `countLiveBlocks`
  // are long enough for the world to move under it.
  //
  // TWO checks, covering different windows — neither implies the other:
  //
  //  - the GENERATION catches what comparing values back cannot. `A→B→A` during
  //    the awaits leaves `activeWorkspaceId` equal to what it was while the
  //    analysis absorbed B's ambient state, and a discarded Repo keeps its own
  //    pin forever, so its own check passes vacuously. The effect restarts on
  //    a Repo swap and on a workspace change alike, so one counter covers both.
  //  - the WORKSPACE check catches the same change EARLIER. The effect restarts
  //    through React, so between `setActiveWorkspaceId` and the restart there is
  //    a window where the generation still matches and the workspace does not.
  //
  // The caller still gets the result; only the chip is spared it.
  const generation = contextGeneration
  const analysis = await runPerfAnalysis(repo, workspaceId, Date.now())
  const contextHeld =
    generation === contextGeneration && repo.activeWorkspaceId === workspaceId
  if (contextHeld && ownsStore(repo)) publishPerfAnalysis(analysis)
  return analysis
}

/** The Repo the published verdicts belong to. A local sign-out swaps the Repo
 *  without a reload, and the store is keyed by workspace alone — so the next
 *  user opening the same shared workspace would be shown the previous user's
 *  verdict until the next pass, over their own client's history. */
let publishedFor: object | null = null

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
const ownsStore = (repo: object): boolean => {
  if (publishedFor === null) publishedFor = repo
  return publishedFor === repo
}

export const perfAnalysisEffect: AppEffect = {
  id: 'perf-monitor.analyze',
  start: ({ repo, workspaceId }) => {
    if (!workspaceId) return
    contextGeneration++
    if (!ownsStore(repo)) {
      // NOT the store's `reset`: that drops the LISTENERS too, and a
      // `useSyncExternalStore` subscriber never comes back from it — it
      // re-subscribes only when the `subscribe` identity changes, and this one
      // is module-stable. The chip would hold the pre-swap verdict for the rest
      // of the session, deaf to every later publish.
      clearPerfAnalyses()
      publishedFor = repo
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
    return job.start(async () => { await runPerfAnalysisNow(repo, workspaceId) })
  },
}

export const perfAnalysisEffectContribution = appEffectsFacet.of(perfAnalysisEffect, {
  source: 'perf-monitor',
})
