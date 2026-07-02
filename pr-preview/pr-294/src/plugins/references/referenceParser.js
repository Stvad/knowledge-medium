import { unified } from "../../../node_modules/unified/lib/index.js";
import remarkParse from "../../../node_modules/remark-parse/lib/index.js";
import { visit } from "../../../node_modules/unist-util-visit/lib/index.js";
//#region src/plugins/references/referenceParser.ts
/**
* Reference parser + renderer for `[[alias]]` and `((block-id))`
* syntax. Owned by the references plugin — this is the canonical
* grammar for wikilinks and blockrefs across the codebase.
*
* Consumers (outside this plugin): the roam importer reads from
* here. Anything that emits the syntax should also use the
* `renderWikilink` / `renderAliasedBlockref` helpers below to avoid
* drift from parser expectations (`]]` cannot be represented
* exactly inside wikilink text, `]` / newlines in blockref labels,
* regex-meta + `$&` in aliases through `rewriteWikilinks`).
*
* Plain-text parsing here is preferred over the markdown-aware
* variant for hot paths; the markdown-aware fallback exists for
* surfaces that must skip code blocks (see `parseReferencesMarkdownAware`).
*/
var UUID_RE_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
var ALIASED_BLOCK_REF_RE = new RegExp(`\\[([^\\]\\n]*)\\]\\(\\(\\((${UUID_RE_SOURCE})\\)\\)\\)`, "gi");
var BLOCK_REF_RE = new RegExp(`\\(\\((${UUID_RE_SOURCE})\\)\\)`, "gi");
var BLOCK_EMBED_RE = new RegExp(`!\\(\\((${UUID_RE_SOURCE})\\)\\)`, "gi");
var BLOCK_REF_TARGET_RE = new RegExp(`^\\(\\((${UUID_RE_SOURCE})\\)\\)$`, "i");
var isBlockRefId = (s) => new RegExp(`^${UUID_RE_SOURCE}$`, "i").test(s);
var parseBlockRefTarget = (target) => {
	const match = BLOCK_REF_TARGET_RE.exec(target.trim());
	return match ? match[1].toLowerCase() : null;
};
var parseWikilinkReferences = (content) => {
	const references = [];
	const stack = [];
	let i = 0;
	while (i < content.length - 1) if (content.slice(i, i + 2) === "[[") {
		stack.push(i);
		i += 2;
	} else if (content.slice(i, i + 2) === "]]") {
		if (stack.length > 0) {
			const startPos = stack.pop();
			const alias = content.slice(startPos + 2, i);
			if (alias) references.push({
				alias,
				startIndex: startPos,
				endIndex: i + 2
			});
		}
		i += 2;
	} else i++;
	return references.sort((a, b) => a.startIndex - b.startIndex);
};
/**
* Parse every balanced `[[alias]]` pattern from text content. Nested
* wikilinks emit both the outer and inner references, matching Roam's
* backlink behavior.
*/
function parseReferences(content) {
	return parseWikilinkReferences(content);
}
/**
* Parse only the outermost balanced `[[alias]]` spans. Use this when a
* caller needs token boundaries for text rewriting/rendering, where
* overlapping nested spans would corrupt slicing.
*/
function parseOutermostReferences(content) {
	const references = parseWikilinkReferences(content);
	const outermost = [];
	let cursor = 0;
	for (const ref of references) {
		if (ref.startIndex < cursor) continue;
		outermost.push(ref);
		cursor = ref.endIndex;
	}
	return outermost;
}
/**
* Parse references using remark for markdown-aware extraction
* This version respects markdown structure (ignores code blocks, etc.)
*/
function parseReferencesMarkdownAware(content) {
	const references = [];
	try {
		visit(unified().use(remarkParse).parse(content), "text", (node, _index, parent) => {
			if (["code", "inlineCode"].includes(parent?.type)) return;
			const text = node.value;
			references.push(...parseReferences(text));
		});
	} catch (error) {
		console.warn("Error parsing references:", error);
		return parseReferences(content);
	}
	return references;
}
/**
* Extract just the alias strings from content
* @param content The text content to parse
* @returns Array of unique alias strings found
*/
function extractAliases(content) {
	const references = parseReferences(content);
	const uniqueAliases = new Set(references.map((ref) => ref.alias));
	return Array.from(uniqueAliases);
}
/**
* Check if content contains any references
* @param content The text content to check
* @returns True if content contains [[alias]] patterns
*/
function hasReferences(content) {
	return parseReferences(content).length > 0;
}
/**
* Parse `((uuid))` block-refs, `!((uuid))` block-embeds, and Roam-style
* `[label](((uuid)))` aliased block refs out of text. More specific forms are
* matched first so their inner `((uuid))` spans are not double-counted.
*/
function parseBlockRefs(content) {
	const found = [];
	const consumed = [];
	const overlapsConsumed = (start, end) => consumed.some(([s, e]) => start < e && end > s);
	ALIASED_BLOCK_REF_RE.lastIndex = 0;
	let match;
	while ((match = ALIASED_BLOCK_REF_RE.exec(content)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		const label = match[1].trim();
		found.push({
			blockId: match[2].toLowerCase(),
			startIndex: start,
			endIndex: end,
			embed: false,
			...label ? { label } : {}
		});
		consumed.push([start, end]);
	}
	BLOCK_EMBED_RE.lastIndex = 0;
	while ((match = BLOCK_EMBED_RE.exec(content)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (overlapsConsumed(start, end)) continue;
		found.push({
			blockId: match[1].toLowerCase(),
			startIndex: start,
			endIndex: end,
			embed: true
		});
		consumed.push([start, end]);
	}
	BLOCK_REF_RE.lastIndex = 0;
	while ((match = BLOCK_REF_RE.exec(content)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (overlapsConsumed(start, end)) continue;
		found.push({
			blockId: match[1].toLowerCase(),
			startIndex: start,
			endIndex: end,
			embed: false
		});
	}
	return found.sort((a, b) => a.startIndex - b.startIndex);
}
function extractBlockRefIds(content) {
	return Array.from(new Set(parseBlockRefs(content).map((r) => r.blockId)));
}
/** Render a wikilink targeting `alias`. If `alias` contains the closing
*  wikilink delimiter, the output is syntactically safe but lossy;
*  callers that need alias identity must verify by parsing the result. */
var renderWikilink = (alias) => {
	return `[[${alias.replace(/]]/g, "] ]")}]]`;
};
/** Render an aliased blockref `[label](((id)))`. Strips `]` and
*  newlines from `label` because the parser's regex rejects them in
*  the label segment (see `ALIASED_BLOCK_REF_RE`). `id` is assumed
*  to be a UUID — already safe. */
var renderAliasedBlockref = (label, id) => {
	return `[${label.replace(/[\]\n]/g, "")}](((${id})))`;
};
/** Replace every wikilink whose alias exactly matches `alias` with
*  the literal `replacement` string. Uses `parseReferences` to find
*  spans and avoids the
*  `String.replace` regex-replacement-string pitfall where `$&`,
*  `$1`, etc. in `replacement` would be interpreted as backreferences
*  rather than literals. Returns the input unchanged when no span
*  matches. */
var rewriteWikilinks = (content, alias, replacement) => {
	if (alias === "") return content;
	const marks = parseReferences(content);
	if (marks.length === 0) return content;
	let result = "";
	let cursor = 0;
	for (const mark of marks) {
		if (mark.startIndex < cursor) continue;
		if (mark.alias !== alias) continue;
		result += content.slice(cursor, mark.startIndex);
		result += replacement;
		cursor = mark.endIndex;
	}
	return cursor === 0 ? content : result + content.slice(cursor);
};
/** Replace block-ref marks targeting `blockId` with inline text — used
*  when the target block is deleted so its references degrade gracefully
*  to the text they displayed rather than dangling. Plain `((id))` and
*  embed `!((id))` marks (which display the target's content) become
*  `inlineContent`; aliased `[label](((id)))` marks (which display the
*  label) keep their `label`. Marks targeting other ids are untouched.
*  Mirrors `rewriteBlockRefs`'s parse-spans-and-slice approach so
*  `inlineContent` is inserted literally (no `String.replace` `$&`
*  pitfall) and overlapping/nested marks don't corrupt the slicing. */
var inlineBlockRefs = (content, blockId, inlineContent) => {
	const normalizedId = blockId.toLowerCase();
	const marks = parseBlockRefs(content);
	if (marks.length === 0) return content;
	let result = "";
	let cursor = 0;
	for (const mark of marks) {
		if (mark.startIndex < cursor) continue;
		if (mark.blockId !== normalizedId) continue;
		result += content.slice(cursor, mark.startIndex);
		result += mark.label !== void 0 ? mark.label : inlineContent;
		cursor = mark.endIndex;
	}
	return cursor === 0 ? content : result + content.slice(cursor);
};
/** Replace block-ref ids in `((id))`, `!((id))`, and `[label](((id)))`
*  forms while preserving embed-ness and display labels. */
var rewriteBlockRefs = (content, fromId, toId) => {
	const normalizedFrom = fromId.toLowerCase();
	const marks = parseBlockRefs(content);
	if (marks.length === 0) return content;
	let result = "";
	let cursor = 0;
	for (const mark of marks) {
		if (mark.startIndex < cursor) continue;
		if (mark.blockId !== normalizedFrom) continue;
		result += content.slice(cursor, mark.startIndex);
		if (mark.label !== void 0) result += renderAliasedBlockref(mark.label, toId);
		else result += mark.embed ? `!((${toId}))` : `((${toId}))`;
		cursor = mark.endIndex;
	}
	return cursor === 0 ? content : result + content.slice(cursor);
};
//#endregion
export { extractAliases, extractBlockRefIds, hasReferences, inlineBlockRefs, isBlockRefId, parseBlockRefTarget, parseBlockRefs, parseOutermostReferences, parseReferences, parseReferencesMarkdownAware, renderAliasedBlockref, renderWikilink, rewriteBlockRefs, rewriteWikilinks };

//# sourceMappingURL=referenceParser.js.map