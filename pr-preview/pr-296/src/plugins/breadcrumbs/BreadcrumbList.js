import { breadcrumbRenderScopeId } from "../../utils/renderScope.js";
import { cn } from "../../lib/utils.js";
import { NestedBlockContextProvider, useBlockContext } from "../../context/block.js";
import { buildAppHash } from "../../utils/routing.js";
import { BlockComponent } from "../../components/BlockComponent.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/breadcrumbs/BreadcrumbList.tsx
var INNER_CLASS = "pointer-events-none inline [&>*]:inline [&>p]:m-0 [&>*]:whitespace-nowrap [&>*]:overflow-hidden [&>*]:text-ellipsis [&>*]:font-normal [&>*]:text-inherit";
var BreadcrumbList = (t0) => {
	const $ = c(20);
	const { parents, workspaceId, overrides, onSelect, onLinkClick, className, itemClassName, separatorClassName } = t0;
	const blockContext = useBlockContext();
	const parentRenderScopeId = typeof blockContext.renderScopeId === "string" ? blockContext.renderScopeId : "breadcrumb-root";
	if (parents.length === 0) return null;
	let t1;
	if ($[0] !== itemClassName || $[1] !== onLinkClick || $[2] !== onSelect || $[3] !== overrides || $[4] !== parentRenderScopeId || $[5] !== parents || $[6] !== separatorClassName || $[7] !== workspaceId) {
		let t2;
		if ($[9] !== itemClassName || $[10] !== onLinkClick || $[11] !== onSelect || $[12] !== overrides || $[13] !== parentRenderScopeId || $[14] !== separatorClassName || $[15] !== workspaceId) {
			t2 = (parent, index) => /* @__PURE__ */ jsxs("span", {
				className: "flex items-center min-w-0",
				children: [/* @__PURE__ */ jsx("a", {
					href: buildAppHash(workspaceId, parent.id),
					className: cn("text-inherit", itemClassName),
					onClickCapture: (event) => {
						event.stopPropagation();
						if (onSelect && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
							event.preventDefault();
							onSelect(parent);
							return;
						}
						onLinkClick?.(event, parent);
					},
					children: /* @__PURE__ */ jsx("span", {
						className: INNER_CLASS,
						children: /* @__PURE__ */ jsx(NestedBlockContextProvider, {
							overrides: {
								...overrides,
								scopeRootId: parent.id,
								renderScopeId: breadcrumbRenderScopeId(parentRenderScopeId, parent.id, String(index))
							},
							children: /* @__PURE__ */ jsx(BlockComponent, { blockId: parent.id })
						})
					})
				}), /* @__PURE__ */ jsx("span", {
					className: separatorClassName,
					children: "›"
				})]
			}, parent.id);
			$[9] = itemClassName;
			$[10] = onLinkClick;
			$[11] = onSelect;
			$[12] = overrides;
			$[13] = parentRenderScopeId;
			$[14] = separatorClassName;
			$[15] = workspaceId;
			$[16] = t2;
		} else t2 = $[16];
		t1 = parents.map(t2);
		$[0] = itemClassName;
		$[1] = onLinkClick;
		$[2] = onSelect;
		$[3] = overrides;
		$[4] = parentRenderScopeId;
		$[5] = parents;
		$[6] = separatorClassName;
		$[7] = workspaceId;
		$[8] = t1;
	} else t1 = $[8];
	let t2;
	if ($[17] !== className || $[18] !== t1) {
		t2 = /* @__PURE__ */ jsx("div", {
			className,
			children: t1
		});
		$[17] = className;
		$[18] = t1;
		$[19] = t2;
	} else t2 = $[19];
	return t2;
};
//#endregion
export { BreadcrumbList };

//# sourceMappingURL=BreadcrumbList.js.map