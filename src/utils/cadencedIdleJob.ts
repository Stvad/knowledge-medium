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
      /** Which arming the pending work belongs to. EXACTLY ONE chain is live,
       *  and this is what makes that true rather than a property of the call
       *  order.
       *
       *  `clearTimeout` alone cannot enforce it: an arming passes through three
       *  phases — a pending timer, a callback queued on idle, a run in flight —
       *  and only the first is a timer to clear. A re-arm during either of the
       *  others left the superseded work to arm its OWN successor, so the loop
       *  ran two chains from then on, each later re-arm adding another. */
      let generation = 0
      const armIn = (delayMs: number): void => {
        const mine = ++generation
        timer = setTimeout(() => {
          jobs.schedule(async () => {
            // The generation half is DEFENCE IN DEPTH and unpinned: it skips a
            // pass superseded while its callback sat on the idle queue, which
            // saves redundant work but cannot affect how many chains are live —
            // the check after the run already prevents a superseded arming
            // scheduling a successor. Kept because running an analysis whose
            // answer someone has already superseded is pure cost.
            if (cancelled || mine !== generation) return
            let next: number | void
            try {
              next = await run()
            } catch (err) {
              console.warn(`[${label}] run failed`, err)
              next = opts?.onFailureDelayMs
            }
            // THE one-chain invariant. A run already in flight cannot be
            // recalled, but it must not arm a successor once superseded — that
            // successor is the second chain, and it never goes away.
            if (!cancelled && mine === generation) armIn(next ?? repeatDelayMs)
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
          // Still worth clearing: in the common case the pending work IS a
          // timer, and leaving it to fire would run a pass this re-arm has
          // already replaced. The generation is what covers the other two
          // phases, where there is nothing to clear.
          if (timer) clearTimeout(timer)
          armIn(delayMs)
        },
      }
    },
  }
}
