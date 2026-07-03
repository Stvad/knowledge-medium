//#region src/components/editModeKeepalive.ts
var refocusHolds = 0;
var yieldHolds = 0;
/** Acquire a keepalive hold. Returns the release fn; callers MUST schedule the
*  release (timer / cleanup / finally). Idempotent — the returned fn is safe to
*  call more than once but only decrements its counter once. */
var acquireEditModeKeepalive = (mode) => {
	if (mode === "refocus") refocusHolds++;
	else yieldHolds++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (mode === "refocus") refocusHolds--;
		else yieldHolds--;
	};
};
/** What the editor's blur handler should do, given any active holds:
*   - 'exit'    — no hold; proceed with the normal exit-on-blur.
*   - 'refocus' — a hold is active and no surface owns focus; keep edit mode and
*                 snap focus back to the editor.
*   - 'yield'   — a surface owns focus; keep edit mode but leave focus where it
*                 is (the surface restores editor focus on close). */
var resolveEditModeKeepalive = () => {
	if (yieldHolds > 0) return "yield";
	if (refocusHolds > 0) return "refocus";
	return "exit";
};
/** How long a hold lingers past the point its action resolves. The blur the
*  hold exists to outlast lands AFTER the mutation's promise settles — the
*  reparent rides PowerSync → React render → DOM commit → blur, several frames
*  late and variably (~150ms on mobile WebViews in Playwright). Releasing the
*  instant the action resolves would drop the hold before the blur it's meant to
*  suppress; 400ms covers the worst case with headroom. */
var KEEPALIVE_RELEASE_DELAY_MS = 400;
/** Hold an edit-mode keepalive for the duration of `fn`, then release it on a
*  delay (so the late post-commit blur above still sees the hold). The standard
*  wrapper for fire-and-forget edit-mode surfaces — a mobile toolbar button, the
*  image picker — so no caller hand-rolls acquire / try-finally / timed-release
*  and risks leaking a hold (a leaked hold pins edit mode app-wide). Re-throws
*  whatever `fn` throws, but only AFTER scheduling the release, so an error can't
*  strand the hold.
*
*  NOT for lifecycle-bound holds: the command palette holds across its whole
*  open lifetime and releases in an effect cleanup, which doesn't map to a single
*  async call — it acquires/releases directly.
*
*  Contract: `fn` MUST eventually settle (resolve or reject). The release is
*  scheduled off `fn`'s settlement, so a never-settling promise pins the hold
*  (and edit mode) until reload — there's deliberately no internal timeout here,
*  since a generous one risks pre-empting a legitimately slow action's hold. Both
*  callers satisfy this: the picker's `pickImageFiles` has its own absolute
*  backstop, and `runAction` settles. A new caller that can hang must carry its
*  own backstop (as the picker does). */
var withEditModeKeepalive = async (mode, fn) => {
	const release = acquireEditModeKeepalive(mode);
	try {
		return await fn();
	} finally {
		setTimeout(release, KEEPALIVE_RELEASE_DELAY_MS);
	}
};
//#endregion
export { acquireEditModeKeepalive, resolveEditModeKeepalive, withEditModeKeepalive };

//# sourceMappingURL=editModeKeepalive.js.map