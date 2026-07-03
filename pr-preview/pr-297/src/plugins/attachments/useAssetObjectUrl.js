import { useEffect, useState } from "react";
import { c } from "react/compiler-runtime";
//#region src/plugins/attachments/useAssetObjectUrl.ts
/**
* Resolve a media block's bytes to an `<img>`-usable object URL (design §7.3/§11).
*
* Bridges the in-thread {@link AssetResolver} (which yields verified BYTES, never
* a URL — the security core stays DOM-free, §7.3) to the renderer: it resolves,
* wraps the verified bytes as a `Blob` of the block's MIME, and hands back a
* `blob:` object URL — owning the createObjectURL / revokeObjectURL lifecycle so
* the renderer never leaks one.
*
* Fail-closed surfaces as `status: 'error'` (the resolver already discarded any
* unverified bytes, §5.1) — the renderer shows the broken-asset placeholder; we
* never createObjectURL for a failed resolve. A resolve that finishes after the
* inputs change (or the component unmounts) is dropped and its URL never created,
* so there's no stale-URL race and no leak.
*
* A TRANSIENT failure (the Storage object hasn't replicated to this device yet,
* the browser is offline, or the workspace is locked) can clear without any of the
* hook's inputs changing — so caching it as a settled result would leave the image
* broken until a remount/reload. For those reasons we re-resolve on reconnect
* (`online`) and tab refocus (`visibilitychange`). Terminal failures (hash
* mismatch, decode failure, malformed hash) won't change without a block edit, so
* they stay put.
*/
/** Failures that may clear on their own (object arrives / network recovers /
*  workspace unlocks / re-paste the WK), so a refocus/reconnect should retry.
*  `media-undecodable` is deliberately ABSENT — the bytes won't become decodable
*  without a block edit, so it's terminal. */
var TRANSIENT_FAILURES = new Set([
	"fetch-failed",
	"deferred",
	"no-content-key",
	"error"
]);
function useAssetObjectUrl(args, resolver, t0) {
	const $ = c(29);
	let t1;
	if ($[0] !== t0) {
		t1 = t0 === void 0 ? {} : t0;
		$[0] = t0;
		$[1] = t1;
	} else t1 = $[1];
	const options = t1;
	const { workspaceId, contentHash, mime } = args;
	const enabled = options.enabled ?? true;
	const key = `${workspaceId} ${contentHash} ${mime}`;
	const [settled, setSettled] = useState(null);
	const [retryTick, setRetryTick] = useState(0);
	let t2;
	if ($[2] !== contentHash || $[3] !== enabled || $[4] !== key || $[5] !== mime || $[6] !== resolver || $[7] !== workspaceId) {
		t2 = () => {
			if (!enabled) return;
			let cancelled = false;
			let objectUrl = null;
			resolver.resolve({
				workspaceId,
				contentHash
			}).then((result) => {
				if (cancelled) return;
				if (!result.ok) {
					setSettled({
						key,
						state: {
							status: "error",
							reason: result.reason
						}
					});
					return;
				}
				objectUrl = URL.createObjectURL(new Blob([result.bytes], { type: mime }));
				setSettled({
					key,
					state: {
						status: "ready",
						url: objectUrl
					}
				});
			}).catch(() => {
				if (!cancelled) setSettled({
					key,
					state: {
						status: "error",
						reason: "error"
					}
				});
			});
			return () => {
				cancelled = true;
				if (objectUrl) URL.revokeObjectURL(objectUrl);
			};
		};
		$[2] = contentHash;
		$[3] = enabled;
		$[4] = key;
		$[5] = mime;
		$[6] = resolver;
		$[7] = workspaceId;
		$[8] = t2;
	} else t2 = $[8];
	let t3;
	if ($[9] !== contentHash || $[10] !== enabled || $[11] !== key || $[12] !== mime || $[13] !== resolver || $[14] !== retryTick || $[15] !== workspaceId) {
		t3 = [
			enabled,
			resolver,
			workspaceId,
			contentHash,
			mime,
			key,
			retryTick
		];
		$[9] = contentHash;
		$[10] = enabled;
		$[11] = key;
		$[12] = mime;
		$[13] = resolver;
		$[14] = retryTick;
		$[15] = workspaceId;
		$[16] = t3;
	} else t3 = $[16];
	useEffect(t2, t3);
	let t4;
	if ($[17] !== key || $[18] !== settled) {
		t4 = settled?.key === key ? settled.state : { status: "loading" };
		$[17] = key;
		$[18] = settled;
		$[19] = t4;
	} else t4 = $[19];
	const state = t4;
	let t5;
	if ($[20] !== state.reason || $[21] !== state.status) {
		t5 = state.status === "error" && TRANSIENT_FAILURES.has(state.reason);
		$[20] = state.reason;
		$[21] = state.status;
		$[22] = t5;
	} else t5 = $[22];
	const retryable = t5;
	let t6;
	let t7;
	if ($[23] !== retryable) {
		t6 = () => {
			if (!retryable) return;
			const retry = () => setRetryTick(_temp);
			const onVisible = () => {
				if (document.visibilityState === "visible") retry();
			};
			window.addEventListener("online", retry);
			document.addEventListener("visibilitychange", onVisible);
			return () => {
				window.removeEventListener("online", retry);
				document.removeEventListener("visibilitychange", onVisible);
			};
		};
		t7 = [retryable];
		$[23] = retryable;
		$[24] = t6;
		$[25] = t7;
	} else {
		t6 = $[24];
		t7 = $[25];
	}
	useEffect(t6, t7);
	let t8;
	if ($[26] === Symbol.for("react.memo_cache_sentinel")) {
		t8 = (failedUrl) => {
			URL.revokeObjectURL(failedUrl);
			setSettled((prev) => prev?.state.status === "ready" && prev.state.url === failedUrl ? {
				key: prev.key,
				state: {
					status: "error",
					reason: "media-undecodable"
				}
			} : prev);
		};
		$[26] = t8;
	} else t8 = $[26];
	const reportDecodeFailure = t8;
	let t9;
	if ($[27] !== state) {
		t9 = [state, reportDecodeFailure];
		$[27] = state;
		$[28] = t9;
	} else t9 = $[28];
	return t9;
}
function _temp(t) {
	return t + 1;
}
//#endregion
export { useAssetObjectUrl };

//# sourceMappingURL=useAssetObjectUrl.js.map