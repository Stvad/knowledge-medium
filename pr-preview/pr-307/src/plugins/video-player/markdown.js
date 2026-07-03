import VideoTimeStamp from "./VideoTimeStamp.js";
import { remarkTimestamps } from "./remark-timestamps.js";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/video-player/markdown.tsx
var videoPlayerMarkdownExtension = ({ blockContext }) => {
	const videoBlockId = blockContext.videoPlayerBlockId;
	if (typeof videoBlockId !== "string") return null;
	const renderScopeId = typeof blockContext.renderScopeId === "string" ? blockContext.renderScopeId : void 0;
	return {
		remarkPlugins: [remarkTimestamps],
		components: { "time-stamp": ({ node }) => {
			const hms = node?.properties?.hms;
			if (typeof hms !== "string") return null;
			return /* @__PURE__ */ jsx(VideoTimeStamp, {
				hms,
				videoBlockId,
				renderScopeId
			});
		} }
	};
};
//#endregion
export { videoPlayerMarkdownExtension };

//# sourceMappingURL=markdown.js.map