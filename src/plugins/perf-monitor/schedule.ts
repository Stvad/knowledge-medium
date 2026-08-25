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
import { publishPerfAnalysis } from './store.js'

/** Wall clock between analyses. Long: the series it reads only gains a point
 *  per session, and re-deriving the same verdict is pure cost. Short enough
 *  that a regression developing mid-session is still noticed. */
const REANALYZE_MS = 10 * 60_000

const job = cadencedIdleJob({
  firstDelayMs: LAZY_DEEP_IDLE.minDelayMs,
  repeatDelayMs: REANALYZE_MS,
  label: 'perf-monitor',
})

/** Test helper — drain in-flight analyses. */
export const drainPerfAnalyses = (): Promise<void> => job.drain()

/** Run now, publish, return. Used by the effect and by the trend view's manual
 *  refresh. Throws on failure so a caller can surface it. */
export const runPerfAnalysisNow = async (repo: Repo, workspaceId: string) => {
  const analysis = await runPerfAnalysis(repo, workspaceId, Date.now())
  publishPerfAnalysis(analysis)
  return analysis
}

export const perfAnalysisEffect: AppEffect = {
  id: 'perf-monitor.analyze',
  start: ({ repo, workspaceId }) => {
    if (!workspaceId) return
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
