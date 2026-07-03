import { SKIP } from "../../../../../node_modules/unist-util-visit-parents/lib/index.js";
import { visit } from "../../../../../node_modules/unist-util-visit/lib/index.js";
import { parseOutermostReferences } from "../../referenceParser.js";
//#region src/plugins/references/markdown/wikilinks/remark-wikilinks.ts
var LINK_URL_RE = /^\[\[(.+)\]\]$/;
var LINK_FORM_RE = /\[([^[\]\n]*)\]\(\[\[([^[\]\n]+?)\]\]\)/g;
var buildWikilinkNode = (alias, blockId, children, raw, hasCustomDisplay) => ({
	type: "wikilink",
	value: raw,
	children,
	data: {
		hName: "wikilink",
		hProperties: {
			alias,
			blockId,
			hasCustomDisplay
		}
	}
});
var buildPageEmbedNode = (alias, blockId, raw, occurrenceId) => ({
	type: "pageembed",
	value: raw,
	children: [{
		type: "text",
		value: raw
	}],
	data: {
		hName: "pageembed",
		hProperties: {
			alias,
			blockId,
			occurrenceId
		}
	}
});
var isAutolinkLiteral = (node) => {
	if (node.type !== "link") return false;
	if (node.children.length !== 1 || node.children[0].type !== "text") return false;
	const linkPos = node.position;
	const childPos = node.children[0].position;
	if (!(linkPos?.start.offset === childPos?.start.offset && linkPos?.end.offset === childPos?.end.offset)) return false;
	const text = node.children[0].value;
	const url = node.url ?? "";
	return url === `mailto:${text}` || url === `http://${text}` || url === `https://${text}` || url === text;
};
var childSourceForReassembly = (node) => {
	if (node.type === "text") return {
		text: node.value,
		opaque: false
	};
	if (isAutolinkLiteral(node)) return {
		text: node.children[0].value,
		opaque: false
	};
	return {
		text: "\0",
		opaque: true
	};
};
var remarkWikilinks = (options) => (tree) => {
	const resolve = (alias) => options?.resolveAlias?.(alias) ?? "";
	visit(tree, "link", (node, index, parent) => {
		if (index === void 0 || !parent) return;
		const match = LINK_URL_RE.exec(node.url ?? "");
		if (!match) return;
		const alias = match[1];
		if (!alias) return;
		parent.children.splice(index, 1, buildWikilinkNode(alias, resolve(alias), node.children, `[…](${node.url})`, true));
		return [SKIP, index + 1];
	});
	visit(tree, "text", (node, index, parent) => {
		if (index === void 0 || !parent) return;
		const src = node.value;
		LINK_FORM_RE.lastIndex = 0;
		const out = [];
		let last = 0;
		let match;
		while ((match = LINK_FORM_RE.exec(src)) !== null) {
			const [whole, displayText, rawAlias] = match;
			const alias = rawAlias;
			if (!alias) continue;
			if (match.index > last) out.push({
				type: "text",
				value: src.slice(last, match.index)
			});
			out.push(buildWikilinkNode(alias, resolve(alias), [{
				type: "text",
				value: displayText
			}], whole, true));
			last = match.index + whole.length;
		}
		if (out.length === 0) return;
		if (last < src.length) out.push({
			type: "text",
			value: src.slice(last)
		});
		parent.children.splice(index, 1, ...out);
		return [SKIP, index + out.length];
	});
	visit(tree, "text", (node, index, parent) => {
		if (index === void 0 || !parent) return;
		const src = node.value;
		const refs = parseOutermostReferences(src);
		if (refs.length === 0) return;
		const out = [];
		let last = 0;
		for (const ref of refs) {
			const isEmbed = ref.startIndex > 0 && src[ref.startIndex - 1] === "!";
			const spanStart = isEmbed ? ref.startIndex - 1 : ref.startIndex;
			if (spanStart > last) out.push({
				type: "text",
				value: src.slice(last, spanStart)
			});
			const raw = src.slice(spanStart, ref.endIndex);
			out.push(isEmbed ? buildPageEmbedNode(ref.alias, resolve(ref.alias), raw, `text:${(node.position?.start.offset ?? 0) + spanStart}`) : buildWikilinkNode(ref.alias, resolve(ref.alias), [{
				type: "text",
				value: ref.alias
			}], raw, false));
			last = ref.endIndex;
		}
		if (last < src.length) out.push({
			type: "text",
			value: src.slice(last)
		});
		parent.children.splice(index, 1, ...out);
		return [SKIP, index + out.length];
	});
	visit(tree, (node) => {
		const parent = node;
		if (!Array.isArray(parent.children)) return;
		while (reassembleOneCrossNodeRef(parent, resolve));
	});
};
var reassembleOneCrossNodeRef = (parent, resolve) => {
	const kids = parent.children;
	if (kids.length < 3) return false;
	const pieces = [];
	const opaqueFlags = [];
	const starts = [];
	let cursor = 0;
	for (const child of kids) {
		starts.push(cursor);
		const { text, opaque } = childSourceForReassembly(child);
		pieces.push(text);
		opaqueFlags.push(opaque);
		cursor += text.length;
	}
	const joined = pieces.join("");
	const refs = parseOutermostReferences(joined);
	if (refs.length === 0) return false;
	for (const ref of refs) {
		let startChild = pieces.length - 1;
		while (startChild > 0 && starts[startChild] > ref.startIndex) startChild--;
		let endChild = startChild;
		while (endChild < pieces.length - 1 && starts[endChild + 1] < ref.endIndex) endChild++;
		if (startChild === endChild) continue;
		let spansOpaque = false;
		for (let i = startChild; i <= endChild; i++) if (opaqueFlags[i]) {
			spansOpaque = true;
			break;
		}
		if (spansOpaque) continue;
		const isEmbed = ref.startIndex > 0 && joined[ref.startIndex - 1] === "!";
		const spanStart = isEmbed ? ref.startIndex - 1 : ref.startIndex;
		const prefix = pieces[startChild].slice(0, spanStart - starts[startChild]);
		const suffix = pieces[endChild].slice(ref.endIndex - starts[endChild]);
		const raw = joined.slice(spanStart, ref.endIndex);
		const parentOffset = parent.position?.start.offset ?? 0;
		const replacement = [];
		if (prefix.length > 0) replacement.push({
			type: "text",
			value: prefix
		});
		replacement.push(isEmbed ? buildPageEmbedNode(ref.alias, resolve(ref.alias), raw, `cross:${parentOffset + spanStart}`) : buildWikilinkNode(ref.alias, resolve(ref.alias), [{
			type: "text",
			value: ref.alias
		}], raw, false));
		if (suffix.length > 0) replacement.push({
			type: "text",
			value: suffix
		});
		kids.splice(startChild, endChild - startChild + 1, ...replacement);
		return true;
	}
	return false;
};
//#endregion
export { remarkWikilinks };

//# sourceMappingURL=remark-wikilinks.js.map