//#region src/plugins/srs-review/reviewProgress.ts
/** Local calendar day (YYYY-MM-DD), used to invalidate a saved session
*  after a midnight rollover. */
var localDayKey = (now = /* @__PURE__ */ new Date()) => `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
/** The saved session to resume, or null when there's nothing valid to
*  restore (no save, a different deck tag, or a day rollover). Used as the
*  lazy initial state so a restored queue is non-null from the first
*  render — which keeps the live-snapshot path (gated on `queue === null`)
*  from clobbering it, no extra flag needed. The index is clamped to the
*  queue length so a saved "complete" session (index === length) resumes
*  on the completion screen rather than out of bounds. */
var restoreSavedSession = (progress, tagName, todayKey) => {
	if (progress && progress.queue.length > 0 && progress.tag === tagName && progress.day === todayKey) return {
		queue: progress.queue,
		index: Math.min(progress.index, progress.queue.length),
		revealed: progress.revealed
	};
	return null;
};
/** Reconcile a restored queue against the live due set: keep everything
*  already reviewed (`< index`, so Back/re-grade still works) and drop
*  not-yet-reached cards (`>= index`) that are no longer due — e.g.
*  rescheduled on another surface since the session was saved. Returns the
*  same array reference when nothing was dropped so callers can skip a
*  needless state update. */
var reconcileRestoredQueue = (queue, index, dueIds) => {
	const upcoming = queue.slice(index).filter((id) => dueIds.has(id));
	const next = [...queue.slice(0, index), ...upcoming];
	return next.length === queue.length ? queue : next;
};
//#endregion
export { localDayKey, reconcileRestoredQueue, restoreSavedSession };

//# sourceMappingURL=reviewProgress.js.map