import { getActiveUserId } from "../../data/repoProvider.js";
import { useRepo } from "../../context/repo.js";
import { armSharedLaneTriggers } from "./laneArming.js";
import { armUploadDrain, runUploadReconcile } from "./assetUpload.js";
import { useEffect } from "react";
import { c } from "react/compiler-runtime";
//#region src/plugins/attachments/MediaUploadReconciler.tsx
/**
* App-root mount that drives the up-lane's opportunistic recovery (design §9).
* Mounted via `appMountsFacet`, it:
*   - runs the boot reconciler at mount (promote recoverable `staged` records, then
*     drain `pending`) — UNCONDITIONALLY, because draining a prior session's pending
*     uploads is REQUIRED work that must not be gated on initial sync: `onFirstSync`
*     never fires in a connected-but-never-synced / offline session (see firstSync.ts),
*     so gating here would strand a whole session's un-uploaded bytes;
*   - re-runs it once initial sync SETTLES, to also promote `staged` records whose
*     blocks only just arrived via that sync (the reconcile is idempotent + the drain
*     is lane-locked, so the already-synced double-fire is harmless);
*   - re-arms the drain on reconnect (`online`) and tab refocus
*     (`visibilitychange` → visible), so a capture that `defer`red (workspace was
*     locked) or hit a transient upload error recovers in-session, not only at the
*     next boot.
*
* Renders nothing. The happy path doesn't need this (capture arms the drain right
* after commit); this is crash/close recovery + the in-session retry sweep.
*/
var MediaUploadReconciler = () => {
	const $ = c(3);
	const repo = useRepo();
	let t0;
	let t1;
	if ($[0] !== repo) {
		t0 = () => {
			const userId = getActiveUserId();
			if (!userId) return;
			const reconcile = () => void runUploadReconcile(userId, repo).catch(_temp);
			reconcile();
			const sweep = _temp2;
			const onVisible = () => {
				if (document.visibilityState === "visible") sweep();
			};
			const disposeShared = armSharedLaneTriggers(userId, reconcile, sweep);
			document.addEventListener("visibilitychange", onVisible);
			return () => {
				disposeShared();
				document.removeEventListener("visibilitychange", onVisible);
			};
		};
		t1 = [repo];
		$[0] = repo;
		$[1] = t0;
		$[2] = t1;
	} else {
		t0 = $[1];
		t1 = $[2];
	}
	useEffect(t0, t1);
	return null;
};
function _temp(err) {
	return console.warn("[media] upload reconcile failed", err);
}
function _temp2() {
	const active = getActiveUserId();
	if (active) armUploadDrain(active);
}
//#endregion
export { MediaUploadReconciler };

//# sourceMappingURL=MediaUploadReconciler.js.map