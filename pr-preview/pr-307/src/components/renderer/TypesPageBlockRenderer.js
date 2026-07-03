import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { blockTypeLabelProp } from "../../data/properties.js";
import { BLOCK_TYPE_TYPE } from "../../data/blockTypes.js";
import { Button } from "../ui/button.js";
import { Plus } from "../../../node_modules/lucide-react/dist/esm/icons/plus.js";
import { MarkdownContentRenderer } from "./MarkdownContentRenderer.js";
import { DefaultBlockRenderer } from "./DefaultBlockRenderer.js";
import { useCallback, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/renderer/TypesPageBlockRenderer.tsx
/** Renderer for the Types page (user-defined-types Phase 1). Wraps the
*  default page layout and surfaces a "New type" button. Children
*  (existing block-type blocks) continue to render via their own
*  BlockTypeBlockRenderer underneath. */
var TypesPageContentRenderer = (props) => {
	const { block } = props;
	const readOnly = block.repo.isReadOnly;
	const [creating, setCreating] = useState(false);
	const createNewType = useCallback(async () => {
		if (creating) return;
		setCreating(true);
		try {
			const childId = await block.repo.mutate.createChild({
				parentId: block.id,
				position: { kind: "last" }
			});
			await block.repo.tx(async (tx) => {
				await block.repo.addTypeInTx(tx, childId, BLOCK_TYPE_TYPE, {});
				await tx.setProperty(childId, blockTypeLabelProp, "");
			}, {
				scope: ChangeScope.BlockDefault,
				description: "new block-type"
			});
		} finally {
			setCreating(false);
		}
	}, [block, creating]);
	return /* @__PURE__ */ jsxs("div", {
		className: "flex w-full items-center justify-between gap-2",
		children: [/* @__PURE__ */ jsx(MarkdownContentRenderer, { ...props }), !readOnly && /* @__PURE__ */ jsxs(Button, {
			type: "button",
			variant: "ghost",
			size: "sm",
			className: "h-7 shrink-0 gap-1 text-xs",
			disabled: creating,
			onClick: () => {
				createNewType();
			},
			children: [/* @__PURE__ */ jsx(Plus, { className: "h-3.5 w-3.5" }), creating ? "Creating…" : "New type"]
		})]
	});
};
TypesPageContentRenderer.displayName = "TypesPageContentRenderer";
var TypesPageBlockRenderer = Object.assign((props) => /* @__PURE__ */ jsx(DefaultBlockRenderer, {
	...props,
	ContentRenderer: TypesPageContentRenderer
}), {
	canRender: ({ block }) => {
		const data = block.peek();
		if (!data) return false;
		const types = data.properties.types;
		return Array.isArray(types) && types.includes("panel:types");
	},
	priority: () => 100
});
TypesPageBlockRenderer.displayName = "TypesPageBlockRenderer";
//#endregion
export { TypesPageBlockRenderer };

//# sourceMappingURL=TypesPageBlockRenderer.js.map