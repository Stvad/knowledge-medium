import { syntaxTree } from "../../node_modules/@codemirror/language/dist/index.js";
//#region src/editor/syntaxContext.ts
/** @lezer/markdown node names that mean "this text is code". FencedCode
*  (``` blocks), CodeBlock (indented), InlineCode (backticks); CodeText
*  is the content node inside the block forms. */
var CODE_NODE_NAMES = new Set([
	"FencedCode",
	"CodeBlock",
	"InlineCode",
	"CodeText"
]);
/** True when `pos` sits inside a markdown code node. Fail-open: if the
*  tree hasn't been parsed up to `pos` yet (resolve lands on the top
*  node), the trigger stays allowed — a rare transient dropdown beats
*  suppressing completions while the parser catches up. */
var isInsideMarkdownCode = (state, pos) => {
	for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) if (CODE_NODE_NAMES.has(node.name)) return true;
	return false;
};
//#endregion
export { isInsideMarkdownCode };

//# sourceMappingURL=syntaxContext.js.map