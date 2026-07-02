import { SKIP } from "../../../../../node_modules/unist-util-visit-parents/lib/index.js";
import { visit } from "../../../../../node_modules/unist-util-visit/lib/index.js";
import { parseBlockRefTarget, parseBlockRefs } from "../../referenceParser.js";
//#region src/plugins/references/markdown/blockrefs/remark-blockrefs.ts
var buildNode = (tag, blockId, raw, occurrenceId, children) => ({
	type: tag,
	value: raw,
	children: children ?? [{
		type: "text",
		value: raw
	}],
	data: {
		hName: tag,
		hProperties: {
			blockId,
			occurrenceId,
			...children ? { aliased: true } : {}
		}
	}
});
var remarkBlockrefs = () => (tree) => {
	visit(tree, "link", (node, index, parent) => {
		if (index === void 0 || !parent) return;
		const blockId = parseBlockRefTarget(node.url ?? "");
		if (!blockId) return;
		parent.children.splice(index, 1, buildNode("blockref", blockId, `[…](${node.url})`, `link:${node.position?.start.offset ?? index}`, node.children));
		return [SKIP, index + 1];
	});
	visit(tree, "text", (node, index, parent) => {
		if (index === void 0 || !parent) return;
		const src = node.value;
		const refs = parseBlockRefs(src);
		if (refs.length === 0) return;
		const out = [];
		let last = 0;
		for (const ref of refs) {
			if (ref.startIndex > last) out.push({
				type: "text",
				value: src.slice(last, ref.startIndex)
			});
			out.push(buildNode(ref.embed ? "blockembed" : "blockref", ref.blockId, src.slice(ref.startIndex, ref.endIndex), `text:${(node.position?.start.offset ?? 0) + ref.startIndex}`, ref.label ? [{
				type: "text",
				value: ref.label
			}] : void 0));
			last = ref.endIndex;
		}
		if (last < src.length) out.push({
			type: "text",
			value: src.slice(last)
		});
		parent.children.splice(index, 1, ...out);
		return [SKIP, index + out.length];
	});
};
//#endregion
export { remarkBlockrefs };

//# sourceMappingURL=remark-blockrefs.js.map