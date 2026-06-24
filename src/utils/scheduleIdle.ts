/** Run `fn` on the next idle frame in the browser, or on the next
 *  task tick under jsdom / Node. Used by app-bootstrap effects whose
 *  side effects (cache priming, telemetry writes, preference defaults)
 *  don't need to land before first paint — moving them off the
 *  critical path keeps the SQLite connection free for the queries
 *  React is suspending on.
 *
 *  Browser path: `requestIdleCallback` with a 2 s safety timeout, so
 *  a perpetually busy main thread still gets the work done eventually.
 *  Test path: `setTimeout(0)`, which vitest fake timers can advance
 *  deterministically (see `flush()` helpers that bump fake time by
 *  1 ms to drain pending zero-delay callbacks).
 *
 *  Use this for work that should run promptly once we're past first
 *  paint — the 2 s cap means it WILL run inside the cold-start window
 *  on a busy load. For heavy or non-urgent maintenance that must stay
 *  out of that window entirely, use `scheduleDeepIdle` instead. */
export const scheduleIdle = (fn: () => void): void => {
  const idle = (globalThis as {requestIdleCallback?: (cb: () => void, opts?: {timeout: number}) => void}).requestIdleCallback
  if (typeof idle === 'function') {
    idle(fn, {timeout: 2000})
  } else {
    setTimeout(fn, 0)
  }
}

/** The idle window a `requestIdleCallback` invocation reports. */
interface IdleDeadlineLike {
  /** True when the browser fired the callback because its `timeout`
   *  elapsed (no genuine idle window arrived), not because the thread
   *  went idle. */
  didTimeout: boolean
  /** Estimated ms of idle budget left in this frame (0 when busy). */
  timeRemaining: () => number
}

type RequestIdleCallback = (
  cb: (deadline: IdleDeadlineLike) => void,
  opts?: {timeout: number},
) => number

/** Below this much reported idle budget we treat a `requestIdleCallback`
 *  firing as a brief lull mid-load, not a genuine idle window, and wait
 *  for a better one. A real idle frame reports up to ~50 ms. */
const DEFAULT_MIN_IDLE_BUDGET_MS = 5

export interface DeepIdleOptions {
  /** Wall-clock floor: don't even start watching for an idle window until
   *  this long after scheduling. Keeps the job clear of the cold-start
   *  window even if the thread goes briefly idle early (e.g. while waiting
   *  on the network). Since these jobs are scheduled right after mount,
   *  this is effectively "this long after boot". */
  minDelayMs: number
  /** Hard cap: if no genuine idle window arrives, force-run by this many ms
   *  after scheduling. Set it for catch-ups that must still complete this
   *  session; OMIT it for purely lazy work that's fine to skip a session in
   *  which the user never goes idle. */
  fallbackMs?: number
  /** Minimum reported idle budget to accept a window as genuine idle
   *  (default `DEFAULT_MIN_IDLE_BUDGET_MS`). */
  minIdleBudgetMs?: number
}

/** Defer `fn` until the main thread is *genuinely* idle, never near boot.
 *
 *  Unlike `scheduleIdle`'s 2 s safety cap — which guarantees the work runs
 *  inside the cold-start window on a busy load, exactly when it contends
 *  with first paint / hydration / the initial sync drain — this:
 *    - waits out a wall-clock floor (`minDelayMs`) before looking at all;
 *    - then watches for a real idle window (`requestIdleCallback` with NO
 *      force-timeout unless `fallbackMs` is set), re-waiting on a too-brief
 *      lull rather than running mid-load;
 *    - force-runs by `fallbackMs` only if asked to.
 *
 *  Test / Node path (no `requestIdleCallback`): a `setTimeout(0)` macrotask
 *  defer, identical to `scheduleIdle`, so the existing drain helpers
 *  (`vi.runAllTimersAsync`, real-timer `setTimeout(0)` + drain) keep working
 *  unchanged. The floor + genuine-idle gating are a production concern that
 *  needs a real idle primitive. */
export const scheduleDeepIdle = (fn: () => void, opts: DeepIdleOptions): void => {
  const ric = (globalThis as {requestIdleCallback?: RequestIdleCallback}).requestIdleCallback
  if (typeof ric !== 'function') {
    setTimeout(fn, 0)
    return
  }
  const minIdleBudget = opts.minIdleBudgetMs ?? DEFAULT_MIN_IDLE_BUDGET_MS
  // Absolute deadline from scheduling time, so rescheduling on a brief lull
  // can't push the force-run past `fallbackMs`.
  const deadline = opts.fallbackMs === undefined ? undefined : Date.now() + opts.fallbackMs
  const watchForIdle = (): void => {
    const ricOpts = deadline === undefined ? undefined : {timeout: Math.max(0, deadline - Date.now())}
    ric((d) => {
      // Run when forced off the deadline, or on a genuine idle window — but
      // re-wait on a brief mid-load lull (low budget, no timeout).
      if (d.didTimeout || d.timeRemaining() >= minIdleBudget) fn()
      else watchForIdle()
    }, ricOpts)
  }
  setTimeout(watchForIdle, opts.minDelayMs)
}

/** Lazy maintenance that's fine to skip in a session where the user never
 *  goes idle (the data-integrity smoke alarm, prefs sub-block bootstraps,
 *  the update-indicator timestamp). Genuine idle only, never near boot. */
export const LAZY_DEEP_IDLE: DeepIdleOptions = {minDelayMs: 60_000}

/** One-time-per-workspace data-completeness catch-ups (ref-typed reprojection,
 *  workspace backfills, the reconcile rescan). Should run THIS session but off
 *  the cold-start window: genuine idle preferred, force-run by the fallback so
 *  a never-idle session still completes them. */
export const CATCHUP_DEEP_IDLE: DeepIdleOptions = {minDelayMs: 10_000, fallbackMs: 30_000}
