import { useRepo } from "../../context/repo.js";
import { useParents } from "../../hooks/block.js";
import { useBlockOpener } from "../../utils/navigation.js";
import { BreadcrumbList } from "./BreadcrumbList.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/breadcrumbs/Breadcrumbs.tsx
var OVERRIDES = {
	isNestedSurface: true,
	isBreadcrumb: true
};
var Breadcrumbs = (t0) => {
	const $ = c(7);
	const { block } = t0;
	const workspaceId = useRepo().activeWorkspaceId;
	const parents = useParents(block);
	const openBlock = useBlockOpener();
	let t1;
	if ($[0] !== openBlock || $[1] !== workspaceId) {
		t1 = (event, parent) => {
			openBlock(event, {
				blockId: parent.id,
				workspaceId
			});
		};
		$[0] = openBlock;
		$[1] = workspaceId;
		$[2] = t1;
	} else t1 = $[2];
	const handleLinkClick = t1;
	let t2;
	if ($[3] !== handleLinkClick || $[4] !== parents || $[5] !== workspaceId) {
		t2 = /* @__PURE__ */ jsx(BreadcrumbList, {
			parents,
			workspaceId,
			overrides: OVERRIDES,
			onLinkClick: handleLinkClick,
			className: "flex items-center gap-1 text-sm text-muted-foreground mb-2 overflow-x-auto py-1 flex-wrap",
			itemClassName: "no-underline cursor-pointer truncate max-w-full",
			separatorClassName: "mx-1 text-muted-foreground/50"
		});
		$[3] = handleLinkClick;
		$[4] = parents;
		$[5] = workspaceId;
		$[6] = t2;
	} else t2 = $[6];
	return t2;
};
//#endregion
export { Breadcrumbs };

//# sourceMappingURL=Breadcrumbs.js.map