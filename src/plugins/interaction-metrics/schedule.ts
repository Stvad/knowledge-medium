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

/** Wall clock between samples after the first. Each sample rewrites one small
 *  block, so this trades series resolution against write volume: a record is
 *  only ever read as its session's endpoint, and the intermediate samples exist
 *  so a session that ends abruptly still leaves one. */
const RESAMPLE_MS = 5 * 60_000

// The re-arm delay is a PLAIN timer, deliberately not `scheduleDeepIdle`'s
// `minDelayMs`: under Node/jsdom `scheduleDeepIdle` collapses to `setTimeout(0)`
// and drops the floor entirely, so a self-re-arming job scheduled through it
// spins once per macrotask — writing to the DB each time — in every test that
// mounts the app. The idle scheduler still gates WHEN a due sample runs; this
// timer gates HOW OFTEN one becomes due, and holds in both environments.
const jobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, LAZY_DEEP_IDLE))

/** Test helper — drain in-flight samples. */
export const drainInteractionSamples = (): Promise<void> => jobs.drain()

export const interactionMetricsEffect: AppEffect = {
  id: 'interaction-metrics.sample',
  start: ({ repo, workspaceId }) => {
    if (!workspaceId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const sample = (): void => {
      jobs.schedule(async () => {
        if (cancelled) return
        try {
          await writeInteractionSample(repo, workspaceId)
        } catch (err) {
          console.warn('[interaction-metrics] failed to write sample', err)
        }
        // Re-arm only after the sample settles, so a slow write on a busy
        // session cannot stack overlapping samples.
        if (!cancelled) timer = setTimeout(sample, RESAMPLE_MS)
      })
    }
    sample()
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
