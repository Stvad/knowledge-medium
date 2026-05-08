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
 *  1 ms to drain pending zero-delay callbacks). */
export const scheduleIdle = (fn: () => void): void => {
  const idle = (globalThis as {requestIdleCallback?: (cb: () => void, opts?: {timeout: number}) => void}).requestIdleCallback
  if (typeof idle === 'function') {
    idle(fn, {timeout: 2000})
  } else {
    setTimeout(fn, 0)
  }
}
