import { editorSelection, focusBlock, requestEditorFocus } from "../../data/properties.js";
import { videoPlayerViewProp } from "./view.js";
//#region src/plugins/video-player/notes.ts
var focusVideoNoteChild = async (noteId, uiStateBlock, renderScopeId) => {
	await focusBlock(uiStateBlock, noteId, {
		edit: !uiStateBlock.repo.isReadOnly,
		renderScopeId
	});
	await uiStateBlock.set(editorSelection, {
		blockId: noteId,
		start: 0
	});
	if (uiStateBlock.repo.isReadOnly) return;
	requestEditorFocus(uiStateBlock);
};
var focusVideoNote = async (videoBlock, uiStateBlock, renderScopeId, preferredNoteId) => {
	const childIds = await videoBlock.childIds.load();
	const noteId = preferredNoteId && childIds.includes(preferredNoteId) ? preferredNoteId : childIds[0];
	if (noteId) {
		await focusVideoNoteChild(noteId, uiStateBlock, renderScopeId);
		return noteId;
	}
	return ensureEditableVideoNoteChild(videoBlock, uiStateBlock, renderScopeId);
};
var ensureEditableVideoNoteChild = async (videoBlock, uiStateBlock, renderScopeId) => {
	if (videoBlock.repo.isReadOnly) return null;
	if ((await videoBlock.childIds.load()).length > 0) return null;
	const newId = await videoBlock.repo.mutate.createChild({
		parentId: videoBlock.id,
		position: { kind: "first" }
	});
	if (!newId) return null;
	await focusVideoNoteChild(newId, uiStateBlock, renderScopeId);
	return newId;
};
var enterVideoNotesView = async (videoBlock, uiStateBlock, renderScopeId) => {
	await videoBlock.set(videoPlayerViewProp, "notes");
	await ensureEditableVideoNoteChild(videoBlock, uiStateBlock, renderScopeId);
};
//#endregion
export { ensureEditableVideoNoteChild, enterVideoNotesView, focusVideoNote };

//# sourceMappingURL=notes.js.map