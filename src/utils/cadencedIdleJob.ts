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

export interface LoopHandle {
  /** Tear the loop down. */
  stop: () => void
  /** Re-arm the pending run at `delayMs` from now, discarding the delay the
   *  last run chose.
   *
   *  For work that happens OUTSIDE the loop but answers the same question it
   *  does — a manual refresh, say. Without this the loop sits on a delay
   *  computed before that work existed, so a look someone just took by hand
   *  cannot bring the next scheduled one forward. */
  rearmIn: (delayMs: number) => void
}

export interface CadencedIdleJob {
  /** Start the loop; returns the disposer.
   *
   *  The run RETURNS its own next delay (or nothing, for `repeatDelayMs`)
   *  rather than writing state a separate delay callback reads afterwards. The
   *  two-callback shape could not express "this pass decided nothing": a run
   *  that refused its own result, or threw, left the previous pass's state
   *  standing and the cadence was then chosen from it. Returning the delay
   *  makes the pass that computed the answer the only thing that can set it.
   *
   *  `onFailureDelayMs` is the answer for a run that THREW, which has no return
   *  value to give one. Without it a transient failure would be rewarded with
   *  the full cadence before the next attempt. */
  start: (
    run: () => Promise<number | void>,
    opts?: { onFailureDelayMs?: number },
  ) => LoopHandle
  /** Test helper — await runs whose deferral has already fired. */
  drain: () => Promise<void>
}

/**
 * @param firstDelayMs wall clock before the first run.
 * @param repeatDelayMs wall clock between runs, measured from the previous
 *   run SETTLING — so a slow run cannot stack overlapping ones. `start` can
 *   override it per loop.
 * @param label prefix for the warning logged when a run throws.
 */
export const cadencedIdleJob = (
  { firstDelayMs, repeatDelayMs, label }:
  { firstDelayMs: number; repeatDelayMs: number; label: string },
): CadencedIdleJob => {
  const jobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, { minDelayMs: 0 }))
  return {
    drain: () => jobs.drain(),
    start: (run, opts) => {
      let cancelled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const armIn = (delayMs: number): void => {
        timer = setTimeout(() => {
          jobs.schedule(async () => {
            if (cancelled) return
            let next: number | void
            try {
              next = await run()
            } catch (err) {
              console.warn(`[${label}] run failed`, err)
              next = opts?.onFailureDelayMs
            }
            if (!cancelled) armIn(next ?? repeatDelayMs)
          })
        }, delayMs)
      }
      armIn(firstDelayMs)
      return {
        stop: () => {
          cancelled = true
          if (timer) clearTimeout(timer)
        },
        rearmIn: (delayMs) => {
          if (cancelled) return
          if (timer) clearTimeout(timer)
          armIn(delayMs)
        },
      }
    },
  }
}
