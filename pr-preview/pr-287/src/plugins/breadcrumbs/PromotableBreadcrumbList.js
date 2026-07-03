import { useBlockOpener } from "../../utils/navigation.js";
import { BreadcrumbList } from "./BreadcrumbList.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/breadcrumbs/PromotableBreadcrumbList.tsx
/** A `BreadcrumbList` wired for promote-in-place: a plain primary click
*  promotes the segment (`onPromote`); modifier clicks fall through to the
*  shared block opener (shift / shift+alt → sidebar / new panel). Used by
*  both the backlink entries and the SRS review session. */
var PromotableBreadcrumbList = (t0) => {
	const $ = c(12);
	const { parents, workspaceId, overrides, onPromote, className, itemClassName, separatorClassName } = t0;
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
	if ($[3] !== className || $[4] !== handleLinkClick || $[5] !== itemClassName || $[6] !== onPromote || $[7] !== overrides || $[8] !== parents || $[9] !== separatorClassName || $[10] !== workspaceId) {
		t2 = /* @__PURE__ */ jsx(BreadcrumbList, {
			parents,
			workspaceId,
			overrides,
			onSelect: onPromote,
			onLinkClick: handleLinkClick,
			className,
			itemClassName,
			separatorClassName
		});
		$[3] = className;
		$[4] = handleLinkClick;
		$[5] = itemClassName;
		$[6] = onPromote;
		$[7] = overrides;
		$[8] = parents;
		$[9] = separatorClassName;
		$[10] = workspaceId;
		$[11] = t2;
	} else t2 = $[11];
	return t2;
};
//#endregion
export { PromotableBreadcrumbList };

//# sourceMappingURL=PromotableBreadcrumbList.js.map