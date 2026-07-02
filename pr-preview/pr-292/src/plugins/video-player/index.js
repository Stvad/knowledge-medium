import { propertySchemasFacet } from "../../data/facets.js";
import { systemToggle } from "../../facets/togglable.js";
import { blockRenderersFacet } from "../../extensions/core.js";
import { markdownExtensionsFacet } from "../../markdown/extensions.js";
import { blockLayoutFacet, shortcutSurfaceActivationsFacet } from "../../extensions/blockInteraction.js";
import { videoNotesPaneRatioProp, videoPlayerViewProp } from "./view.js";
import { videoPlayerActionsExtension, videoPlayerShortcutActivation } from "./actions.js";
import { VideoPlayerRenderer, videoPlayerLayoutContribution } from "./VideoPlayerRenderer.js";
import { videoPlayerMarkdownExtension } from "./markdown.js";
//#region src/plugins/video-player/index.ts
var videoPlayerPlugin = systemToggle({
	id: "system:video-player",
	name: "Video player",
	description: "Inline playback for blocks whose content is a video URL."
}).of([
	propertySchemasFacet.of(videoPlayerViewProp, { source: "video-player" }),
	propertySchemasFacet.of(videoNotesPaneRatioProp, { source: "video-player" }),
	blockRenderersFacet.of({
		id: "videoPlayer",
		renderer: VideoPlayerRenderer
	}, { source: "video-player" }),
	blockLayoutFacet.of(videoPlayerLayoutContribution, { source: "video-player" }),
	markdownExtensionsFacet.of(videoPlayerMarkdownExtension, { source: "video-player" }),
	shortcutSurfaceActivationsFacet.of(videoPlayerShortcutActivation, { source: "video-player" }),
	videoPlayerActionsExtension
]);
//#endregion
export { videoPlayerPlugin };

//# sourceMappingURL=index.js.map