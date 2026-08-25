/**
 * Sampling cadence for the interaction record.
 *
 * Every scheduling choice here answers one constraint: monitoring must not cost
 * the thing it monitors. So a sample runs on GENUINE idle only (`scheduleDeepIdle`
 * with no force-run fallback) behind a wall-clock floor — the same tier the
 * consistency audit uses, chosen for the same reason: it must never land in the
 * time-to-interactivity window. A session where the user never goes idle records
 * nothing, and that is the correct trade.
 */
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import { PendingIdleJobs } from '@/data/internals/idleMarkerJobs.js'
import { scheduleDeepIdle, LAZY_DEEP_IDLE } from '@/utils/scheduleIdle.js'
import { metricsSessionContext, observeWorkspace } from './sessionContext.js'
import { writeInteractionSample } from './record.js'

/** Wall clock before the first sample. Single-sourced from the shared lazy
 *  tier so the floor stays one number, but applied with a plain timer — see
 *  below. */
const FIRST_SAMPLE_MS = LAZY_DEEP_IDLE.minDelayMs

/** Wall clock between samples after the first. Each sample rewrites one small
 *  block, so this trades series resolution against write volume: a record is
 *  only ever read as its session's endpoint, and the intermediate samples exist
 *  so a session that ends abruptly still leaves one. */
const RESAMPLE_MS = 5 * 60_000

// The two halves of "never near boot, only when idle" are scheduled
// separately. The FLOOR is a plain timer: outside the browser
// `scheduleDeepIdle` collapses to `setTimeout(0)` and drops `minDelayMs`, so a
// job whose floor lives there runs immediately. The IDLE WINDOW stays
// `scheduleDeepIdle` with no force-run fallback, and takes `minDelayMs: 0`
// because the floor above already ran.
const jobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, { minDelayMs: 0 }))

/** Test helper — drain in-flight samples. */
export const drainInteractionSamples = (): Promise<void> => jobs.drain()

export const interactionMetricsEffect: AppEffect = {
  id: 'interaction-metrics.sample',
  start: ({ repo, workspaceId }) => {
    if (!workspaceId) return
    // Observed synchronously, at the moment the workspace becomes active.
    observeWorkspace(repo, workspaceId)
    // Asking the same context the write asks, one layer earlier: a client with
    // no durable identity can never accumulate readable history, and that is
    // fixed for the whole page session, so there is no point arming timers.
    // The read-only half is NOT decided here -- it resolves asynchronously
    // after mount, so the write consults it again at the moment it matters.
    if (metricsSessionContext(repo, workspaceId).blockedBy === 'no-persistent-client') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const armIn = (delayMs: number): void => {
      timer = setTimeout(() => {
        jobs.schedule(async () => {
          if (cancelled) return
          try {
            await writeInteractionSample(repo, workspaceId)
          } catch (err) {
            console.warn('[interaction-metrics] failed to write sample', err)
          }
          // Re-arm only after the sample settles, so a slow write on a busy
          // session cannot stack overlapping samples.
          if (!cancelled) armIn(RESAMPLE_MS)
        })
      }, delayMs)
    }
    armIn(FIRST_SAMPLE_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  },
}

export const interactionMetricsEffectContribution = appEffectsFacet.of(
  interactionMetricsEffect,
  { source: 'interaction-metrics' },
)
