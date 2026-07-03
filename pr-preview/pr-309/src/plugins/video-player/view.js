import { ChangeScope } from "../../data/api/changeScope.js";
import { codecs } from "../../data/api/codecs.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
//#region src/plugins/video-player/view.ts
var DEFAULT_VIDEO_NOTES_PANE_RATIO = .8;
var videoPlayerViewProp = defineProperty("video:playerView", {
	codec: codecs.enum(["default", "notes"]),
	defaultValue: "default",
	changeScope: ChangeScope.UiState
});
var videoNotesPaneRatioProp = defineProperty("video:notesPaneRatio", {
	codec: codecs.number,
	defaultValue: DEFAULT_VIDEO_NOTES_PANE_RATIO,
	changeScope: ChangeScope.UserPrefs
});
//#endregion
export { DEFAULT_VIDEO_NOTES_PANE_RATIO, videoNotesPaneRatioProp, videoPlayerViewProp };

//# sourceMappingURL=view.js.map