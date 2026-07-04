import { BlockEmbed } from "../../../../components/references/BlockEmbed.js";
import { remarkBlockrefs } from "./remark-blockrefs.js";
import { BlockRef } from "../../../../components/references/BlockRef.js";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/references/markdown/blockrefs/index.tsx
var getBlockId = (node) => {
	const id = node?.properties?.blockId;
	return typeof id === "string" ? id : "";
};
var getOccurrenceId = (node) => {
	const occurrenceId = node?.properties?.occurrenceId;
	return typeof occurrenceId === "string" && occurrenceId ? occurrenceId : "unknown";
};
var isAliased = (node) => node?.properties?.aliased === true;
var blockrefMarkdownExtension = ({ block }) => ({
	remarkPlugins: [remarkBlockrefs],
	components: {
		blockref: ({ node, children }) => {
			const blockId = getBlockId(node);
			if (!blockId) return null;
			return /* @__PURE__ */ jsx(BlockRef, {
				blockId,
				sourceBlockId: block.id,
				occurrenceId: getOccurrenceId(node),
				children: isAliased(node) ? children : void 0
			});
		},
		blockembed: ({ node }) => {
			const blockId = getBlockId(node);
			if (!blockId) return null;
			return /* @__PURE__ */ jsx(BlockEmbed, {
				blockId,
				sourceBlockId: block.id,
				occurrenceId: getOccurrenceId(node)
			});
		}
	}
});
//#endregion
export { blockrefMarkdownExtension };

//# sourceMappingURL=index.js.map