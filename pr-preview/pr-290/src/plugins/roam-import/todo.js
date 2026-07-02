//#region src/plugins/roam-import/todo.ts
var ROAM_TODO_MARKER_RE = /(^|\s)(?:#\[\[(TODO|DONE)\]\]|#(TODO|DONE)\b|\{\{\s*\[\[(TODO|DONE)\]\]\s*\}\})(?=$|\s)/g;
var extractRoamTodoMarker = (rawContent) => {
	let todoState;
	ROAM_TODO_MARKER_RE.lastIndex = 0;
	return {
		content: rawContent.replace(ROAM_TODO_MARKER_RE, (_match, _lead, pageState, tagState, commandState) => {
			todoState ??= pageState ?? tagState ?? commandState;
			return " ";
		}).replace(/[ \t]{2,}/g, " ").trim(),
		todoState
	};
};
var stripRoamTodoContent = (rawContent) => extractRoamTodoMarker(rawContent ?? "").content;
//#endregion
export { extractRoamTodoMarker, stripRoamTodoContent };

//# sourceMappingURL=todo.js.map