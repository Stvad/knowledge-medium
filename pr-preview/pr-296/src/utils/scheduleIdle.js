//#region src/utils/scheduleIdle.ts
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
var scheduleIdle = (fn) => {
	const idle = globalThis.requestIdleCallback;
	if (typeof idle === "function") idle(fn, { timeout: 2e3 });
	else setTimeout(fn, 0);
};
/** Below this much reported idle budget we treat a `requestIdleCallback`
*  firing as a brief lull mid-load, not a genuine idle window, and wait
*  for a better one. A real idle frame reports up to ~50 ms. */
var DEFAULT_MIN_IDLE_BUDGET_MS = 5;
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
var scheduleDeepIdle = (fn, opts) => {
	const ric = globalThis.requestIdleCallback;
	if (typeof ric !== "function") {
		setTimeout(fn, 0);
		return;
	}
	const minIdleBudget = opts.minIdleBudgetMs ?? DEFAULT_MIN_IDLE_BUDGET_MS;
	const deadline = opts.fallbackMs === void 0 ? void 0 : Date.now() + opts.fallbackMs;
	const watchForIdle = () => {
		let remaining;
		if (deadline !== void 0) {
			remaining = deadline - Date.now();
			if (remaining <= 0) {
				fn();
				return;
			}
		}
		ric((d) => {
			if (d.didTimeout || d.timeRemaining() >= minIdleBudget) fn();
			else watchForIdle();
		}, remaining === void 0 ? void 0 : { timeout: remaining });
	};
	setTimeout(watchForIdle, opts.minDelayMs);
};
/** Lazy maintenance that's fine to skip in a session where the user never
*  goes idle (the data-integrity smoke alarm, prefs sub-block bootstraps,
*  the update-indicator timestamp). Genuine idle only, never near boot. */
var LAZY_DEEP_IDLE = { minDelayMs: 6e4 };
/** One-time-per-workspace data-completeness catch-ups (ref-typed reprojection,
*  workspace backfills, the reconcile rescan). Should run THIS session but off
*  the cold-start window: genuine idle preferred, force-run by the fallback so
*  a never-idle session still completes them. */
var CATCHUP_DEEP_IDLE = {
	minDelayMs: 1e4,
	fallbackMs: 3e4
};
//#endregion
export { CATCHUP_DEEP_IDLE, LAZY_DEEP_IDLE, scheduleDeepIdle, scheduleIdle };

//# sourceMappingURL=scheduleIdle.js.map