import { syntaxTree } from "../../node_modules/@codemirror/language/dist/index.js";
//#region src/editor/syntaxContext.ts
/** @lezer/markdown node names whose text is literal, never prose:
*  code — FencedCode (```), CodeBlock (indented), InlineCode
*  (backticks), CodeText (the content node of the block forms);
*  URL — autolinks and link targets (`http://…/#anchor`, `[t](#anchor)`
*  are anchors, not tags); raw HTML and comments (`<div>#foo`,
*  `<!-- #todo`). */
var LITERAL_NODE_NAMES = new Set([
	"FencedCode",
	"CodeBlock",
	"InlineCode",
	"CodeText",
	"URL",
	"HTMLBlock",
	"HTMLTag",
	"Comment",
	"CommentBlock"
]);
/** True when `pos` sits inside a literal markdown span (code, URL, raw
*  HTML, comment). Fail-open: if the tree hasn't been parsed up to
*  `pos` yet (resolve lands on the top node), the trigger stays
*  allowed — a rare transient dropdown beats suppressing completions
*  while the parser catches up. */
var isInsideLiteralMarkdown = (state, pos) => {
	for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) if (LITERAL_NODE_NAMES.has(node.name)) return true;
	return false;
};
//#endregion
export { isInsideLiteralMarkdown };

//# sourceMappingURL=syntaxContext.js.map