import { usePropertyValue, useWorkspaceId } from "../../hooks/block.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { DefaultBlockRenderer } from "../../components/renderer/DefaultBlockRenderer.js";
import { getAssetResolver } from "./assetResolver.js";
import { mediaFilenameProp, mediaHashProp, mediaMimeProp, mediaSizeProp } from "./mediaBlock.js";
import { pickMediaViewer } from "./mediaViewers.js";
import { mediaViewersFacet } from "./mediaViewersFacet.js";
import { useAssetObjectUrl } from "./useAssetObjectUrl.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/attachments/MediaBlockRenderer.tsx
var MediaContentRenderer = (t0) => {
	const $ = c(21);
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
	let t4;
	if ($[4] !== hash || $[5] !== mime || $[6] !== workspaceId) {
		t4 = {
			workspaceId,
			contentHash: hash,
			mime
		};
		$[4] = hash;
		$[5] = mime;
		$[6] = workspaceId;
		$[7] = t4;
	} else t4 = $[7];
	let t5;
	if ($[8] !== viewer.eager) {
		t5 = { enabled: viewer.eager };
		$[8] = viewer.eager;
		$[9] = t5;
	} else t5 = $[9];
	const [state, reportDecodeFailure] = useAssetObjectUrl(t4, resolver, t5);
	let t6;
	if ($[10] !== hash || $[11] !== workspaceId) {
		t6 = () => resolver.resolve({
			workspaceId,
			contentHash: hash
		});
		$[10] = hash;
		$[11] = workspaceId;
		$[12] = t6;
	} else t6 = $[12];
	const resolveBytes = t6;
	const { Component } = viewer;
	let t7;
	if ($[13] !== Component || $[14] !== filename || $[15] !== mime || $[16] !== reportDecodeFailure || $[17] !== resolveBytes || $[18] !== size || $[19] !== state) {
		t7 = /* @__PURE__ */ jsx(Component, {
			state,
			reportDecodeFailure,
			resolveBytes,
			mime,
			filename,
			size
		});
		$[13] = Component;
		$[14] = filename;
		$[15] = mime;
		$[16] = reportDecodeFailure;
		$[17] = resolveBytes;
		$[18] = size;
		$[19] = state;
		$[20] = t7;
	} else t7 = $[20];
	return t7;
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