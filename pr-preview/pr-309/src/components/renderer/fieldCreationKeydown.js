import { EditorView } from "../../../node_modules/@codemirror/view/dist/index.js";
import { convertEmptyChildBlockToProperty } from "../../utils/propertyCreation.js";
//#region src/components/renderer/fieldCreationKeydown.ts
/** The `>` field-creation shortcut for CodeMirrorContentRenderer: typing `>` in
*  an empty, top-of-doc child block converts it into a property field. Guarded
*  so it never hijacks a normal `>` — a non-empty doc, mid-line cursor, modifier
*  chord, read-only repo, or a parentless/root block all fall through, returning
*  false so CodeMirror inserts the character. The effect itself
*  (`convertEmptyChildBlockToProperty`) is covered separately. */
var handleFieldCreationKeydown = (event, view, block, repo) => {
	if (repo.isReadOnly || event.key !== ">" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return false;
	const selection = view.state.selection.main;
	if (!selection.empty || selection.from !== 0 || view.state.doc.length !== 0) return false;
	if (!block.peek()?.parentId) return false;
	event.preventDefault();
	event.stopPropagation();
	convertEmptyChildBlockToProperty(block, repo).catch((error) => {
		console.error("[CodeMirrorContentRenderer] Failed to create property field", error);
	});
	return true;
};
var createFieldCreationKeydownExtension = (block, repo) => EditorView.domEventHandlers({ keydown: (event, view) => handleFieldCreationKeydown(event, view, block, repo) });
//#endregion
export { createFieldCreationKeydownExtension, handleFieldCreationKeydown };

//# sourceMappingURL=fieldCreationKeydown.js.map