import { EditorSelection } from "../../node_modules/@codemirror/state/dist/index.js";
//#region src/utils/blockrefAutocomplete.ts
/**
* CodeMirror completion source for `((` block-ref syntax. Triggers when the
* cursor is inside `((<filter>` and surfaces blocks whose content matches.
* Picking a candidate inserts `<block-id>))` after the existing `((`.
*
* Companion to backlinkAutocomplete.ts — searches by content instead of alias
* because block refs target arbitrary blocks, not aliased pages.
*/
var stripWhitespace = (s) => s.replace(/\s+/g, " ").trim();
function blockrefCompletionSource(options) {
	return async (context) => {
		const { state, pos } = context;
		const line = state.doc.lineAt(pos);
		const lineText = line.text;
		const linePos = pos - line.from;
		const beforeCursor = lineText.slice(0, linePos);
		const afterCursor = lineText.slice(linePos);
		const openMatch = beforeCursor.match(/\(\(([^)]*?)$/);
		if (!openMatch) return null;
		const filter = openMatch[1];
		if (filter.length === 0 && !context.explicit) return null;
		const startPos = line.from + openMatch.index + 2;
		const closingExists = afterCursor.startsWith("))");
		const hits = await options.searchBlocks(filter);
		if (hits.length === 0) return null;
		return {
			from: startPos,
			to: pos,
			filter: false,
			options: hits.map((hit) => {
				return {
					label: stripWhitespace(hit.content) || hit.id,
					apply: (view, _, from, to) => {
						view.dispatch({
							changes: {
								from,
								to,
								insert: closingExists ? hit.id : `${hit.id}))`
							},
							selection: EditorSelection.cursor(from + hit.id.length + 2)
						});
					},
					type: "variable"
				};
			})
		};
	};
}
//#endregion
export { blockrefCompletionSource };

//# sourceMappingURL=blockrefAutocomplete.js.map