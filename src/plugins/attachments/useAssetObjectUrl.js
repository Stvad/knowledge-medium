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
*  `image-undecodable` is deliberately ABSENT — the bytes won't become decodable
*  without a block edit, so it's terminal. */
var TRANSIENT_FAILURES = new Set([
	"fetch-failed",
	"deferred",
	"no-content-key",
	"error"
]);
function useAssetObjectUrl(args, resolver) {
	const $ = c(25);
	const { workspaceId, contentHash, mime } = args;
	const key = `${workspaceId} ${contentHash} ${mime}`;
	const [settled, setSettled] = useState(null);
	const [retryTick, setRetryTick] = useState(0);
	let t0;
	if ($[0] !== contentHash || $[1] !== key || $[2] !== mime || $[3] !== resolver || $[4] !== workspaceId) {
		t0 = () => {
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
		$[0] = contentHash;
		$[1] = key;
		$[2] = mime;
		$[3] = resolver;
		$[4] = workspaceId;
		$[5] = t0;
	} else t0 = $[5];
	let t1;
	if ($[6] !== contentHash || $[7] !== key || $[8] !== mime || $[9] !== resolver || $[10] !== retryTick || $[11] !== workspaceId) {
		t1 = [
			resolver,
			workspaceId,
			contentHash,
			mime,
			key,
			retryTick
		];
		$[6] = contentHash;
		$[7] = key;
		$[8] = mime;
		$[9] = resolver;
		$[10] = retryTick;
		$[11] = workspaceId;
		$[12] = t1;
	} else t1 = $[12];
	useEffect(t0, t1);
	let t2;
	if ($[13] !== key || $[14] !== settled) {
		t2 = settled?.key === key ? settled.state : { status: "loading" };
		$[13] = key;
		$[14] = settled;
		$[15] = t2;
	} else t2 = $[15];
	const state = t2;
	let t3;
	if ($[16] !== state.reason || $[17] !== state.status) {
		t3 = state.status === "error" && TRANSIENT_FAILURES.has(state.reason);
		$[16] = state.reason;
		$[17] = state.status;
		$[18] = t3;
	} else t3 = $[18];
	const retryable = t3;
	let t4;
	let t5;
	if ($[19] !== retryable) {
		t4 = () => {
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
		t5 = [retryable];
		$[19] = retryable;
		$[20] = t4;
		$[21] = t5;
	} else {
		t4 = $[20];
		t5 = $[21];
	}
	useEffect(t4, t5);
	let t6;
	if ($[22] === Symbol.for("react.memo_cache_sentinel")) {
		t6 = (failedUrl) => {
			URL.revokeObjectURL(failedUrl);
			setSettled((prev) => prev?.state.status === "ready" && prev.state.url === failedUrl ? {
				key: prev.key,
				state: {
					status: "error",
					reason: "image-undecodable"
				}
			} : prev);
		};
		$[22] = t6;
	} else t6 = $[22];
	const reportDecodeFailure = t6;
	let t7;
	if ($[23] !== state) {
		t7 = [state, reportDecodeFailure];
		$[23] = state;
		$[24] = t7;
	} else t7 = $[24];
	return t7;
}
function _temp(t) {
	return t + 1;
}
//#endregion
export { useAssetObjectUrl };

//# sourceMappingURL=useAssetObjectUrl.js.map