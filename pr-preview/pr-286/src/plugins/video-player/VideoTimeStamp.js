import { seekTo } from "./registry.js";
import { hmsToSeconds } from "../../utils/time.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/video-player/VideoTimeStamp.tsx
var VideoTimeStamp = (t0) => {
	const $ = c(13);
	const { hms, videoBlockId, renderScopeId } = t0;
	let t1;
	if ($[0] !== hms) {
		t1 = hmsToSeconds(hms);
		$[0] = hms;
		$[1] = t1;
	} else t1 = $[1];
	const secs = t1;
	let t2;
	if ($[2] !== renderScopeId || $[3] !== secs || $[4] !== videoBlockId) {
		t2 = (e) => {
			e.stopPropagation();
			e.preventDefault();
			seekTo(secs, videoBlockId, renderScopeId);
		};
		$[2] = renderScopeId;
		$[3] = secs;
		$[4] = videoBlockId;
		$[5] = t2;
	} else t2 = $[5];
	const interactionHandler = t2;
	const t3 = `PT${secs}S`;
	let t4;
	if ($[6] !== hms || $[7] !== t3) {
		t4 = /* @__PURE__ */ jsx("time", {
			dateTime: t3,
			children: hms
		});
		$[6] = hms;
		$[7] = t3;
		$[8] = t4;
	} else t4 = $[8];
	let t5;
	if ($[9] !== interactionHandler || $[10] !== secs || $[11] !== t4) {
		t5 = /* @__PURE__ */ jsx("a", {
			onClick: interactionHandler,
			onTouchStart: interactionHandler,
			"data-seconds": secs,
			className: "cursor-pointer",
			children: t4
		});
		$[9] = interactionHandler;
		$[10] = secs;
		$[11] = t4;
		$[12] = t5;
	} else t5 = $[12];
	return t5;
};
//#endregion
export { VideoTimeStamp as default };

//# sourceMappingURL=VideoTimeStamp.js.map