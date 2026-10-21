/**
 * `requestIdleCallback` for hosts that lack it (every WebKit browser). Installed
 * once from the boot shim (main.tsx). A next-task defer reporting a 50 ms
 * budget: it cannot see real idleness, which is why `scheduleDeepIdle`'s
 * wall-clock floor is a separate mechanism from its idle check — without the
 * primitive that scheduler's test-only `setTimeout(0)` branch would run every
 * deep-idle pass inside the cold-start window. `timeout` needs no handling:
 * firing on the next task is always within it.
 */
import type { IdleDeadlineLike, RequestIdleCallback } from './scheduleIdle'

const FRAME_BUDGET_MS = 50

export const installIdleCallbackPolyfill = (): void => {
  const host = globalThis as {
    requestIdleCallback?: RequestIdleCallback
    cancelIdleCallback?: (handle: number) => void
  }
  if (typeof host.requestIdleCallback === 'function') return
  host.requestIdleCallback = (cb: (deadline: IdleDeadlineLike) => void) => {
    const start = Date.now()
    return setTimeout(
      () => cb({didTimeout: false, timeRemaining: () => Math.max(0, FRAME_BUDGET_MS - (Date.now() - start))}),
      1,
    ) as unknown as number
  }
  host.cancelIdleCallback = (handle) => clearTimeout(handle)
}
