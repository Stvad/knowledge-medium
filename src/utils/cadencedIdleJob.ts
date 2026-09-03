/**
 * A job that runs on genuine idle, on a cadence, until torn down.
 *
 * The two halves of "never near boot, only when idle" are scheduled
 * separately, and that split is the whole reason this exists as a helper.
 * Outside the browser `scheduleDeepIdle` collapses to `setTimeout(0)` and drops
 * its `minDelayMs`, so a job whose floor lives there runs immediately — once
 * per macrotask for a self-re-arming one, in every test that mounts the app.
 * The FLOOR is therefore a plain timer, which holds in both environments; the
 * IDLE WINDOW stays `scheduleDeepIdle` with no force-run fallback, so a due run
 * still waits for a genuinely free main thread.
 */
import { PendingIdleJobs } from '@/data/internals/idleMarkerJobs.js'
import { scheduleDeepIdle } from '@/utils/scheduleIdle.js'

export interface CadencedIdleJob {
  /** Start the loop; returns the disposer. */
  start: (run: () => Promise<void>) => () => void
  /** Test helper — await runs whose deferral has already fired. */
  drain: () => Promise<void>
}

/**
 * @param firstDelayMs wall clock before the first run.
 * @param repeatDelayMs wall clock between runs, measured from the previous
 *   run SETTLING — so a slow run cannot stack overlapping ones.
 * @param label prefix for the warning logged when a run throws.
 */
export const cadencedIdleJob = (
  { firstDelayMs, repeatDelayMs, label }:
  { firstDelayMs: number; repeatDelayMs: number; label: string },
): CadencedIdleJob => {
  const jobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, { minDelayMs: 0 }))
  return {
    drain: () => jobs.drain(),
    start: (run) => {
      let cancelled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const armIn = (delayMs: number): void => {
        timer = setTimeout(() => {
          jobs.schedule(async () => {
            if (cancelled) return
            try {
              await run()
            } catch (err) {
              console.warn(`[${label}] run failed`, err)
            }
            if (!cancelled) armIn(repeatDelayMs)
          })
        }, delayMs)
      }
      armIn(firstDelayMs)
      return () => {
        cancelled = true
        if (timer) clearTimeout(timer)
      }
    },
  }
}
