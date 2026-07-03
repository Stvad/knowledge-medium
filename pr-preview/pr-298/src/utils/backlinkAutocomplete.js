import { EditorSelection } from "../../node_modules/@codemirror/state/dist/index.js";
import { keymap } from "../../node_modules/@codemirror/view/dist/index.js";
import { autocompletion } from "../../node_modules/@codemirror/autocomplete/dist/index.js";
import { completionKeymapWithEscapeFallthrough } from "./codemirrorCompletion.js";
//#region src/utils/backlinkAutocomplete.ts
/**
* CodeMirror extension for [[alias]] autocomplete
* Triggers on [[ input and shows available aliases
*/
/**
* Create autocomplete extension for backlinks
*/
function createBacklinkAutocomplete(options) {
	return [autocompletion({
		override: [backlinkCompletionSource(options)],
		defaultKeymap: false
	}), keymap.of(completionKeymapWithEscapeFallthrough)];
}
/**
* Completion source for [[alias]] syntax
*/
function backlinkCompletionSource(options) {
	return async (context) => {
		const { state, pos } = context;
		const line = state.doc.lineAt(pos);
		const lineText = line.text;
		const linePos = pos - line.from;
		const beforeCursor = lineText.slice(0, linePos);
		const afterCursor = lineText.slice(linePos);
		const openBracketMatch = beforeCursor.match(/\[\[([^\]]*?)$/);
		if (!openBracketMatch) return null;
		const hasClosingBrackets = afterCursor.indexOf("]]") !== -1;
		const searchTerm = openBracketMatch[1];
		const startPos = line.from + openBracketMatch.index + 2;
		const candidates = await options.getAliases(searchTerm);
		if (candidates.length === 0) return null;
		return {
			from: startPos,
			to: pos,
			filter: false,
			options: candidates.map((candidate) => {
				const label = typeof candidate === "string" ? candidate : candidate.label;
				const applyText = typeof candidate === "string" ? candidate : candidate.apply ?? candidate.label;
				return {
					label,
					detail: typeof candidate === "string" ? void 0 : candidate.detail,
					apply: (view, _, from, to) => {
						view.dispatch({
							changes: {
								from,
								to,
								insert: hasClosingBrackets ? applyText : `${applyText}]]`
							},
							selection: EditorSelection.cursor(from + applyText.length + 2)
						});
					},
					type: typeof candidate === "string" ? "class" : candidate.type ?? "class"
				};
			})
		};
	};
}
/**
* Check if cursor is currently inside [[ ]] brackets
*/
function isInsideBacklinkBrackets(text, position) {
	const beforeCursor = text.slice(0, position);
	const afterCursor = text.slice(position);
	if (beforeCursor.lastIndexOf("[[") > beforeCursor.lastIndexOf("]]")) {
		const nextCloseBrackets = afterCursor.indexOf("]]");
		const nextOpenBrackets = afterCursor.indexOf("[[");
		return nextCloseBrackets !== -1 && (nextOpenBrackets === -1 || nextCloseBrackets < nextOpenBrackets);
	}
	return false;
}
//#endregion
export { backlinkCompletionSource, createBacklinkAutocomplete, isInsideBacklinkBrackets };

//# sourceMappingURL=backlinkAutocomplete.js.map