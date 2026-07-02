import v4 from "../../node_modules/uuid/dist/v4.js";
import { keyAtEnd } from "../data/orderKey.js";
//#region src/utils/markdownParser.ts
/** Wrap `content` verbatim as a single root `ParsedBlock` — no markdown
*  splitting, newlines preserved inside the one block. Used for "paste as
*  one block" (the block-shell paste when the decision is `single-block`).
*  The `orderKey` is a placeholder; insertion paths recompute it. */
var singleParsedBlock = (content) => ({
	id: v4(),
	orderKey: keyAtEnd(),
	content
});
function parseMarkdownToBlocks(text) {
	const lines = text.split("\n");
	const parsedBlocks = [];
	let baseIndent = -1;
	const contextStack = [{
		level: -1,
		rawIndent: -1,
		id: "ROOT",
		type: "root"
	}];
	function determineLineTypeAndContent(trimmedLine) {
		if (trimmedLine.startsWith("#")) {
			const match = trimmedLine.match(/^(#+)\s*(.*)/);
			if (match) return {
				type: `h${match[1].length}`,
				content: trimmedLine
			};
		}
		const ulMatch = trimmedLine.match(/^([-*+])\s+(.*)/);
		if (ulMatch) return {
			type: "ul-item",
			content: ulMatch[2]
		};
		if (trimmedLine.match(/^(\d+\.)\s+(.*)/)) return {
			type: "ol-item",
			content: trimmedLine
		};
		return {
			type: "text",
			content: trimmedLine
		};
	}
	for (const line of lines) {
		const originalLineContent = line;
		const trimmedLine = line.trim();
		if (!trimmedLine) continue;
		const currentLineRawIndent = getIndentationLevel(originalLineContent);
		const { type: currentLineType, content: processedContent } = determineLineTypeAndContent(trimmedLine);
		if (baseIndent === -1) baseIndent = currentLineRawIndent;
		while (contextStack.length > 1) {
			const parentCtx = contextStack[contextStack.length - 1];
			const currentHeaderNum = currentLineType.startsWith("h") ? parseInt(currentLineType.substring(1)) : 0;
			const parentHeaderNum = parentCtx.type.startsWith("h") ? parseInt(parentCtx.type.substring(1)) : 0;
			if (currentLineRawIndent > parentCtx.rawIndent) break;
			else if (currentLineRawIndent === parentCtx.rawIndent) if (parentCtx.type.startsWith("h") && !currentLineType.startsWith("h")) break;
			else if (parentCtx.type.startsWith("h") && currentLineType.startsWith("h")) if (currentHeaderNum > parentHeaderNum) break;
			else contextStack.pop();
			else if (parentCtx.type === "ul-item" && currentLineType === "ul-item" || parentCtx.type === "ol-item" && currentLineType === "ol-item") contextStack.pop();
			else contextStack.pop();
			else contextStack.pop();
		}
		const calculatedLevel = contextStack[contextStack.length - 1].level + 1;
		const newBlockId = v4();
		parsedBlocks.push({
			content: processedContent,
			level: calculatedLevel,
			id: newBlockId
		});
		contextStack.push({
			level: calculatedLevel,
			rawIndent: currentLineRawIndent,
			id: newBlockId,
			type: currentLineType
		});
	}
	const blocks = [];
	const parentStack = [];
	let rootLastKey = null;
	for (const parsed of parsedBlocks) {
		const id = v4();
		while (parentStack.length > parsed.level) parentStack.pop();
		let parentId;
		let orderKey;
		if (parsed.level > 0 && parentStack.length === parsed.level && parentStack[parsed.level - 1]) {
			const parent = parentStack[parsed.level - 1];
			parentId = parent.id;
			orderKey = keyAtEnd(parent.lastOrderKey);
			parent.lastOrderKey = orderKey;
		} else {
			orderKey = keyAtEnd(rootLastKey);
			rootLastKey = orderKey;
		}
		while (parentStack.length < parsed.level) parentStack.push(void 0);
		parentStack[parsed.level] = {
			id,
			lastOrderKey: null
		};
		blocks.push({
			id,
			parentId,
			orderKey,
			content: parsed.content
		});
	}
	return blocks;
}
function getIndentationLevel(line) {
	const indentMatch = line.match(/^[\s\t]*/)?.[0] || "";
	return Math.floor(indentMatch.length / 2);
}
//#endregion
export { parseMarkdownToBlocks, singleParsedBlock };

//# sourceMappingURL=markdownParser.js.map