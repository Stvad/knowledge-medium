import { BlockEmbed } from "../../../../components/references/BlockEmbed.js";
import { remarkWikilinks } from "./remark-wikilinks.js";
import { Wikilink } from "./Wikilink.js";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/references/markdown/wikilinks/index.tsx
var wikilinkMarkdownExtension = ({ block, data }) => {
	const refMap = new Map(data.references.filter((ref) => ref.alias !== ref.id).map(({ alias, id }) => [alias, id]));
	const workspaceId = data.workspaceId;
	return {
		remarkPlugins: [[remarkWikilinks, { resolveAlias: (alias) => refMap.get(alias) }]],
		components: {
			wikilink: ({ node, children }) => {
				const alias = node?.properties?.alias;
				const blockId = node?.properties?.blockId;
				const hasCustomDisplay = node?.properties?.hasCustomDisplay === true;
				if (typeof alias !== "string") return null;
				return /* @__PURE__ */ jsx(Wikilink, {
					alias,
					blockId: typeof blockId === "string" ? blockId : "",
					sourceBlock: block,
					workspaceId,
					hasCustomDisplay,
					children
				});
			},
			pageembed: ({ node }) => {
				const blockId = node?.properties?.blockId;
				if (typeof blockId !== "string" || !blockId) return null;
				const occurrenceId = node?.properties?.occurrenceId;
				return /* @__PURE__ */ jsx(BlockEmbed, {
					blockId,
					sourceBlockId: block.id,
					occurrenceId: typeof occurrenceId === "string" && occurrenceId ? occurrenceId : "unknown"
				});
			}
		}
	};
};
//#endregion
export { wikilinkMarkdownExtension };

//# sourceMappingURL=index.js.map