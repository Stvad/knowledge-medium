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
// separately, on purpose.
//
// The FLOOR is a plain timer. Under Node/jsdom `scheduleDeepIdle` collapses to
// `setTimeout(0)` and drops `minDelayMs` entirely, so a job scheduled through it
// runs immediately — which in tests means every file that mounts the app writes
// metrics records, on a repo that may not even have this plugin's type seeds
// registered. That surfaced as an unhandled error from an unrelated test file,
// and would have been test pollution even when it succeeded. A plain timer
// holds in both environments.
//
// The IDLE WINDOW stays `scheduleDeepIdle`, with no force-run fallback, so a
// due sample still waits for the main thread to be genuinely free rather than
// landing mid-interaction. `minDelayMs: 0` because the floor above already ran.
const jobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, { minDelayMs: 0 }))

/** Test helper — drain in-flight samples. */
export const drainInteractionSamples = (): Promise<void> => jobs.drain()

export const interactionMetricsEffect: AppEffect = {
  id: 'interaction-metrics.sample',
  start: ({ repo, workspaceId }) => {
    if (!workspaceId) return
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
