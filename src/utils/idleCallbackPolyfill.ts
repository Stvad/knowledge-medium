/**
 * `requestIdleCallback` for hosts that lack it — every iOS browser and
 * desktop Safari (all WebKit). Installed once from the boot shim (main.tsx).
 *
 * Without it, `scheduleIdle` / `scheduleDeepIdle` (src/utils/scheduleIdle.ts)
 * take their no-primitive branch, which is `setTimeout(0)`: on WebKit every
 * "deep idle" catch-up pass — the reference-target derive sweep, ref
 * reprojection, workspace backfills, seed materialization — then fires inside
 * the cold-start window and holds the single SQLite worker while bootstrap's
 * own reads queue behind it (measured on an iPhone: ~1–1.9 s of the boot).
 *
 * The emulation is the usual shape: a macrotask defer that reports a full
 * 50 ms frame budget. It cannot know whether the thread is genuinely idle, so
 * `scheduleDeepIdle`'s wall-clock floor is what keeps jobs off the boot path
 * here — which is why the floor exists as a separate mechanism from the
 * idle check. `timeout` needs no handling: the callback fires on the next
 * task regardless, always within any timeout a caller could pass.
 */

interface IdleDeadline {
  didTimeout: boolean
  timeRemaining: () => number
}

type IdleHost = {
  requestIdleCallback?: (cb: (deadline: IdleDeadline) => void, opts?: {timeout: number}) => number
  cancelIdleCallback?: (handle: number) => void
}

const FRAME_BUDGET_MS = 50

export const installIdleCallbackPolyfill = (host: IdleHost = globalThis as IdleHost): void => {
  if (typeof host.requestIdleCallback === 'function') return
  host.requestIdleCallback = (cb) => {
    const start = Date.now()
    return setTimeout(
      () => cb({didTimeout: false, timeRemaining: () => Math.max(0, FRAME_BUDGET_MS - (Date.now() - start))}),
      1,
    ) as unknown as number
  }
  host.cancelIdleCallback = (handle) => clearTimeout(handle)
}
