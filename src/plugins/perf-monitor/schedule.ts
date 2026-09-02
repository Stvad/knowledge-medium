/**
 * Cadenced scheduling for the performance analysis, on the same terms as the
 * recorder: genuine idle only, never near boot.
 */
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import type { Repo } from '@/data/repo'
import { LAZY_DEEP_IDLE } from '@/utils/scheduleIdle.js'
import { cadencedIdleJob } from '@/utils/cadencedIdleJob.js'
import { metricsSessionContext, observeWorkspace } from '@/plugins/interaction-metrics/sessionContext.js'
import { blockedPerfAnalysis, runPerfAnalysis } from './analyze.js'
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
  const analysis = await runPerfAnalysis(repo, workspaceId, Date.now())
  // Both checks are about the same window — the history reads and
  // `countLiveBlocks` take long enough for the world to move under them — but
  // they answer different questions, and neither implies the other.
  //
  // The workspace can change, and the analysis draws on AMBIENT state
  // (`repo.isReadOnly` describes whichever workspace is active now, the live
  // counters are page-global), so publishing would attach the new workspace's
  // blocker to the old one's verdict.
  //
  // The REPO can change too, on a local sign-out with no reload. A discarded
  // Repo keeps its own `activeWorkspaceId` forever — nobody clears it — so its
  // check passes vacuously and it would publish the previous user's verdict
  // into the store the new one is reading. Ask who owns the store instead.
  //
  // The caller still gets the result either way; only the chip is spared it.
  if (ownsStore(repo) && repo.activeWorkspaceId === workspaceId) {
    publishPerfAnalysis(analysis)
  }
  return analysis
}

/** The Repo the published verdicts belong to. A local sign-out swaps the Repo
 *  without a reload, and the store is keyed by workspace alone — so the next
 *  user opening the same shared workspace would be shown the previous user's
 *  verdict until the next pass, over their own client's history. */
let publishedFor: object | null = null

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
    // Without a durable client id the reader derives a fresh group id every
    // load, so no scan can ever find history — but the chip still has to SAY
    // so, or the one state this environment can be in is the one it never
    // shows. Publish the verdict, skip the scans, and stop.
    const blockedBy = metricsSessionContext(repo, workspaceId).blockedBy
    if (blockedBy === 'no-persistent-client') {
      publishPerfAnalysis(blockedPerfAnalysis(workspaceId, blockedBy, Date.now()))
      return
    }
    return job.start(async () => { await runPerfAnalysisNow(repo, workspaceId) })
  },
}

export const perfAnalysisEffectContribution = appEffectsFacet.of(perfAnalysisEffect, {
  source: 'perf-monitor',
})
