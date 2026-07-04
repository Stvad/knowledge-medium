import { usePropertyValue, useWorkspaceId } from "../../hooks/block.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { DefaultBlockRenderer } from "../../components/renderer/DefaultBlockRenderer.js";
import { getAssetResolver } from "./assetResolver.js";
import { mediaFilenameProp, mediaHashProp, mediaMimeProp, mediaSizeProp } from "./mediaBlock.js";
import { pickMediaViewer } from "./mediaViewers.js";
import { mediaViewersFacet } from "./mediaViewersFacet.js";
import { useAssetObjectUrl } from "./useAssetObjectUrl.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/attachments/MediaBlockRenderer.tsx
/**
* The `media`-block renderer (design §11). Mirrors the video-player plugin's
* wiring: a {@link BlockRenderer} that renders blocks carrying the `media` type
* (gated on a loaded snapshot, see canRender) at a priority above the default.
*
* It reads the block's metadata and dispatches to a viewer chosen from the
* {@link mediaViewersFacet} registry ({@link pickMediaViewer}). Byte access is
* per-viewer (§7.3):
*  - an EAGER viewer (image; inline PDF later) gets the bytes resolved once on mount
*    into a verified object URL ({@link useAssetObjectUrl}: fetch → decrypt/passthrough →
*    HASH-VERIFY → Blob of the block's `media:mime` → object URL, revoked on unmount). A
*    fail-closed resolve (§5.1) surfaces as `error` → the broken-asset placeholder, NEVER
*    a raw/unverified source.
*  - a LAZY-INLINE viewer (audio) renders from metadata and resolves NOTHING on mount; it
*    arms the SAME object-URL resolve via `requestResolve` on the first play intent, then
*    reads the resulting `state` exactly like an eager viewer (same fail-closed guarantee).
*  - the LAZY download fallback resolves NOTHING on mount either; it gets a `resolveBytes`
*    thunk and fetches the verified bytes only when the user clicks download.
* The mount-time resolve is gated on `viewer.eager || armed` (armed = a lazy-inline viewer
* called requestResolve). The down-lane already replicates every media block (incl.
* non-image) to local disk for offline (§8), so deferring the resolve isn't about saving
* egress — it avoids holding a decrypted object-URL Blob in memory for media nobody opened
* (a page of large audio files), and avoids un-throttled demand-fetching ahead of that
* budgeted background lane.
*/
var MediaContentRenderer = (t0) => {
	const $ = c(23);
	const { block } = t0;
	const [hash] = usePropertyValue(block, mediaHashProp);
	const [mime] = usePropertyValue(block, mediaMimeProp);
	const [filename] = usePropertyValue(block, mediaFilenameProp);
	const [size] = usePropertyValue(block, mediaSizeProp);
	const workspaceId = useWorkspaceId(block, "");
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = getAssetResolver();
		$[0] = t1;
	} else t1 = $[0];
	const resolver = t1;
	const t2 = useAppRuntime();
	let t3;
	if ($[1] !== mime || $[2] !== t2) {
		t3 = pickMediaViewer(t2.read(mediaViewersFacet), mime);
		$[1] = mime;
		$[2] = t2;
		$[3] = t3;
	} else t3 = $[3];
	const viewer = t3;
	const contentKey = `${workspaceId} ${hash} ${mime}`;
	const [armed, setArmed] = useState(false);
	const [armedFor, setArmedFor] = useState(contentKey);
	if (armedFor !== contentKey) {
		setArmedFor(contentKey);
		if (armed) setArmed(false);
	}
	let t4;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = () => setArmed(true);
		$[4] = t4;
	} else t4 = $[4];
	const requestResolve = t4;
	let t5;
	if ($[5] !== hash || $[6] !== mime || $[7] !== workspaceId) {
		t5 = {
			workspaceId,
			contentHash: hash,
			mime
		};
		$[5] = hash;
		$[6] = mime;
		$[7] = workspaceId;
		$[8] = t5;
	} else t5 = $[8];
	const t6 = viewer.eager || armed;
	let t7;
	if ($[9] !== t6) {
		t7 = { enabled: t6 };
		$[9] = t6;
		$[10] = t7;
	} else t7 = $[10];
	const [state, reportDecodeFailure] = useAssetObjectUrl(t5, resolver, t7);
	let t8;
	if ($[11] !== hash || $[12] !== workspaceId) {
		t8 = () => resolver.resolve({
			workspaceId,
			contentHash: hash
		});
		$[11] = hash;
		$[12] = workspaceId;
		$[13] = t8;
	} else t8 = $[13];
	const resolveBytes = t8;
	const { Component } = viewer;
	let t9;
	if ($[14] !== Component || $[15] !== armed || $[16] !== filename || $[17] !== mime || $[18] !== reportDecodeFailure || $[19] !== resolveBytes || $[20] !== size || $[21] !== state) {
		t9 = /* @__PURE__ */ jsx(Component, {
			state,
			reportDecodeFailure,
			resolveBytes,
			requestResolve,
			armed,
			mime,
			filename,
			size
		});
		$[14] = Component;
		$[15] = armed;
		$[16] = filename;
		$[17] = mime;
		$[18] = reportDecodeFailure;
		$[19] = resolveBytes;
		$[20] = size;
		$[21] = state;
		$[22] = t9;
	} else t9 = $[22];
	return t9;
};
var MediaBlockRenderer = (props) => {
	const $ = c(2);
	let t0;
	if ($[0] !== props) {
		t0 = /* @__PURE__ */ jsx(DefaultBlockRenderer, {
			...props,
			ContentRenderer: MediaContentRenderer
		});
		$[0] = props;
		$[1] = t0;
	} else t0 = $[1];
	return t0;
};
MediaBlockRenderer.canRender = ({ block }) => {
	const types = block.peek()?.properties.types;
	return Array.isArray(types) && types.includes("media");
};
MediaBlockRenderer.priority = () => 5;
//#endregion
export { MediaBlockRenderer, MediaContentRenderer };

//# sourceMappingURL=MediaBlockRenderer.js.map