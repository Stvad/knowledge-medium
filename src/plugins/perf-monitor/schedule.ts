/**
 * Cadenced scheduling for the performance analysis, on the same terms as the
 * interaction recorder: genuine idle only, never near boot. See
 * `@/plugins/interaction-metrics/schedule` for why the re-arm delay is a plain
 * timer rather than the idle scheduler's own floor.
 */
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import type { Repo } from '@/data/repo'
import { PendingIdleJobs } from '@/data/internals/idleMarkerJobs.js'
import { scheduleDeepIdle, LAZY_DEEP_IDLE } from '@/utils/scheduleIdle.js'
import { observeWorkspace } from '@/plugins/interaction-metrics/sessionContext.js'
import { runPerfAnalysis } from './analyze.js'
import { publishPerfAnalysis } from './store.js'

/** Wall clock before the first analysis, and between later ones. Long: the
 *  series it reads only gains a point per session, and re-deriving the same
 *  verdict is pure cost. Short enough that a regression which develops
 *  mid-session is still noticed. */
const FIRST_ANALYSIS_MS = LAZY_DEEP_IDLE.minDelayMs
const REANALYZE_MS = 10 * 60_000

// Floor on a plain timer, idle window on `scheduleDeepIdle` — the split and its
// reason are documented in `@/plugins/interaction-metrics/schedule`. Here it
// matters mostly so a test that mounts the app does not run a workspace scan
// per file.
const jobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, { minDelayMs: 0 }))

/** Test helper — drain in-flight analyses. */
export const drainPerfAnalyses = (): Promise<void> => jobs.drain()

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
    // At activation, not at analysis time: a session can enter a second
    // workspace and leave again long before the first analysis is due, and the
    // page-global counters carry its work regardless.
    observeWorkspace(workspaceId)
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const armIn = (delayMs: number): void => {
      timer = setTimeout(() => {
        jobs.schedule(async () => {
          if (cancelled) return
          try {
            await runPerfAnalysisNow(repo, workspaceId)
          } catch (err) {
            console.warn('[perf-monitor] analysis failed', err)
          }
          if (!cancelled) armIn(REANALYZE_MS)
        })
      }, delayMs)
    }
    armIn(FIRST_ANALYSIS_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  },
}

export const perfAnalysisEffectContribution = appEffectsFacet.of(perfAnalysisEffect, {
  source: 'perf-monitor',
})
