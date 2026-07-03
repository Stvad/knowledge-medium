//#region src/utils/viewTransition.ts
/**
* View Transitions wrapper for structural block moves.
*
* Indent/outdent moves a block from one parent's children list to
* another's. Even with `HandleStore`'s fused-notify barrier (so the two
* parents' loaders flush in the same React commit), the block component
* itself still unmounts under the old parent and remounts under the
* new — there's no DOM identity to preserve across distinct React
* parents, so the new mount renders into a different DOM node.
*
* The View Transitions API smooths this: the browser captures a
* snapshot of the current page, runs the callback, captures the
* post-callback state, and crossfades between them. The visual gap
* between "block gone from old parent" and "block reappears under new
* parent" becomes a short transition instead of a hard cut.
*
* Timing inside the callback: `repo.mutate.indent(...)` resolves at
* tx-commit time, BEFORE the handle loaders re-run and React commits.
* We must hold the callback open until those are done, or the browser
* snapshots the still-old DOM. `requestAnimationFrame` is throttled
* during a view transition (RAFs don't tick while the snapshot is
* being captured), so we use macrotask + microtask drains instead:
* one `setTimeout(0)` to cross a macrotask boundary (lets the
* PowerSync worker's SQL response land), then a handful of
* `Promise.resolve()` ticks to drain the loader-settle and notify
* microtasks. React 18 auto-batching commits within that window.
*/
var drainTasks = async () => {
	await new Promise((r) => setTimeout(r, 0));
	for (let i = 0; i < 4; i++) await Promise.resolve();
};
/** Reentrancy guard. Multi-select operations call wrapped actions per
*  block; without this, each nested `withMoveTransition` would skip
*  the outer transition (spec: starting a transition while one is
*  active cancels the active one), so only the last block's animation
*  would play. With the guard, only the outermost call creates a real
*  transition — nested calls just run their callback inline. */
var inTransition = false;
var withMoveTransition = async (run) => {
	if (typeof document === "undefined" || typeof document.startViewTransition !== "function") {
		await run();
		return;
	}
	if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
		await run();
		return;
	}
	if (inTransition) {
		await run();
		return;
	}
	inTransition = true;
	try {
		await document.startViewTransition(async () => {
			await run();
			await drainTasks();
		}).updateCallbackDone;
	} finally {
		inTransition = false;
	}
};
//#endregion
export { withMoveTransition };

//# sourceMappingURL=viewTransition.js.map