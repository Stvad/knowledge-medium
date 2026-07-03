import { focusBlock } from "../../data/properties.js";
import { Block } from "../../data/block.js";
import { actionContextsFacet, actionsFacet } from "../../extensions/core.js";
import { EditorSelection } from "../../../node_modules/@codemirror/state/dist/index.js";
import { EditorView } from "../../../node_modules/@codemirror/view/dist/index.js";
import { isVideoPlayerFocusActive, requestCurrentTime, requestVideoPlayerFocus } from "./registry.js";
import { videoPlayerViewProp } from "./view.js";
import { enterVideoNotesView, focusVideoNote } from "./notes.js";
//#region src/plugins/video-player/actions.ts
var VIDEO_PLAYER_CONTEXT = "video-player";
var isVideoPlayerShortcutDependencies = (deps) => typeof deps === "object" && deps !== null && "uiStateBlock" in deps && deps.uiStateBlock instanceof Block && "block" in deps && deps.block instanceof Block && "videoBlock" in deps && deps.videoBlock instanceof Block && (!("renderScopeId" in deps) || deps.renderScopeId === void 0 || typeof deps.renderScopeId === "string") && (!("editorView" in deps) || deps.editorView === void 0 || deps.editorView instanceof EditorView);
var videoPlayerActionContext = {
	type: VIDEO_PLAYER_CONTEXT,
	displayName: "Video Player",
	validateDependencies: isVideoPlayerShortcutDependencies
};
var formatVideoTimestamp = (seconds) => {
	const totalSeconds = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor(totalSeconds % 3600 / 60);
	const paddedSeconds = (totalSeconds % 60).toString().padStart(2, "0");
	if (hours === 0) return `${minutes}:${paddedSeconds}`;
	return [
		hours,
		minutes.toString().padStart(2, "0"),
		paddedSeconds
	].join(":");
};
var insertIntoEditor = (editorView, text) => {
	editorView.dispatch(editorView.state.changeByRange((range) => ({
		changes: {
			from: range.from,
			to: range.to,
			insert: text
		},
		range: EditorSelection.cursor(range.from + text.length)
	})));
	editorView.focus();
};
var appendToBlock = async (block, text) => {
	const data = block.peek() ?? await block.load();
	if (!data) return;
	const separator = data.content.trim().length > 0 ? " " : "";
	await block.setContent(`${data.content}${separator}${text.trim()}`);
};
var createTimestampNote = async (videoBlock, uiStateBlock, text, renderScopeId) => {
	const newId = await videoBlock.repo.mutate.createChild({
		parentId: videoBlock.id,
		content: text.trim(),
		position: { kind: "first" }
	});
	if (newId) await focusBlock(uiStateBlock, newId, { renderScopeId });
};
var videoPlayerActions = [
	{
		id: "video.insert_timestamp",
		description: "Insert current video timestamp",
		context: VIDEO_PLAYER_CONTEXT,
		handler: async (deps) => {
			if (!isVideoPlayerShortcutDependencies(deps)) return;
			const currentTime = requestCurrentTime(deps.videoBlock.id, deps.renderScopeId);
			if (currentTime === void 0) return;
			const timestamp = `${formatVideoTimestamp(currentTime)} `;
			if (deps.editorView) {
				insertIntoEditor(deps.editorView, timestamp);
				return;
			}
			if (deps.block.id === deps.videoBlock.id) {
				await createTimestampNote(deps.videoBlock, deps.uiStateBlock, timestamp, deps.renderScopeId);
				return;
			}
			await appendToBlock(deps.block, timestamp);
		},
		defaultBinding: {
			keys: "$mod+Shift+t",
			eventOptions: { preventDefault: true }
		}
	},
	{
		id: "video.toggle_notes_view",
		description: "Toggle video notes view",
		context: VIDEO_PLAYER_CONTEXT,
		handler: async (deps) => {
			if (!isVideoPlayerShortcutDependencies(deps)) return;
			if ((deps.videoBlock.peekProperty(videoPlayerViewProp) ?? videoPlayerViewProp.defaultValue) === "notes") {
				await deps.videoBlock.set(videoPlayerViewProp, "default");
				return;
			}
			await enterVideoNotesView(deps.videoBlock, deps.uiStateBlock, deps.renderScopeId);
		},
		defaultBinding: {
			keys: "$mod+Shift+n",
			eventOptions: { preventDefault: true }
		}
	},
	{
		id: "video.toggle_focus",
		description: "Switch focus between video and notes",
		context: VIDEO_PLAYER_CONTEXT,
		handler: async (deps) => {
			if (!isVideoPlayerShortcutDependencies(deps)) return;
			if (isVideoPlayerFocusActive(deps.videoBlock.id, deps.renderScopeId)) {
				const preferredNoteId = deps.block.id === deps.videoBlock.id ? void 0 : deps.block.id;
				await focusVideoNote(deps.videoBlock, deps.uiStateBlock, deps.renderScopeId, preferredNoteId);
				return;
			}
			requestVideoPlayerFocus(deps.videoBlock.id, deps.renderScopeId);
		},
		defaultBinding: {
			keys: "$mod+Shift+Space",
			eventOptions: { preventDefault: true }
		}
	}
];
var videoPlayerShortcutActivation = (context) => {
	const videoBlockId = context.blockContext?.videoPlayerBlockId;
	if (typeof videoBlockId !== "string") return null;
	const dependencies = {
		block: context.block,
		videoBlock: context.repo.block(videoBlockId)
	};
	const renderScopeId = typeof context.blockContext?.renderScopeId === "string" ? context.blockContext.renderScopeId : void 0;
	if (renderScopeId) dependencies.renderScopeId = renderScopeId;
	if (context.surface === "codemirror") {
		if (!context.editorView || context.block.id === videoBlockId) return null;
		return [{
			context: VIDEO_PLAYER_CONTEXT,
			dependencies: {
				...dependencies,
				editorView: context.editorView
			}
		}];
	}
	if (context.surface !== "block" || !context.inFocus || context.inEditMode || context.isSelected) return null;
	return [{
		context: VIDEO_PLAYER_CONTEXT,
		dependencies
	}];
};
var videoPlayerActionsExtension = [actionContextsFacet.of(videoPlayerActionContext, { source: "video-player" }), videoPlayerActions.map((action) => actionsFacet.of(action, { source: "video-player" }))];
//#endregion
export { VIDEO_PLAYER_CONTEXT, formatVideoTimestamp, videoPlayerActionContext, videoPlayerActions, videoPlayerActionsExtension, videoPlayerShortcutActivation };

//# sourceMappingURL=actions.js.map