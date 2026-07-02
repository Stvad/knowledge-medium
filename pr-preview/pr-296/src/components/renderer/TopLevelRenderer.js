import { outlineRenderScopeId } from "../../utils/renderScope.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { NestedBlockContextProvider } from "../../context/block.js";
import { useActionContext } from "../../shortcuts/useActionContext.js";
import { Header } from "../Header.js";
import { BlockComponent } from "../BlockComponent.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/renderer/TopLevelRenderer.tsx
function TopLevelRenderer(t0) {
	const $ = c(12);
	const { block } = t0;
	useActionContext(ActionContextTypes.GLOBAL);
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = { paddingTop: "env(safe-area-inset-top, 0px)" };
		$[0] = t1;
	} else t1 = $[0];
	let t2;
	if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = /* @__PURE__ */ jsx(Header, {});
		$[1] = t2;
	} else t2 = $[1];
	let t3;
	if ($[2] !== block.id) {
		t3 = outlineRenderScopeId(block.id);
		$[2] = block.id;
		$[3] = t3;
	} else t3 = $[3];
	let t4;
	if ($[4] !== block.id || $[5] !== t3) {
		t4 = {
			layoutBoundary: false,
			renderScopeId: t3,
			scopeRootId: block.id
		};
		$[4] = block.id;
		$[5] = t3;
		$[6] = t4;
	} else t4 = $[6];
	let t5;
	if ($[7] !== block.id) {
		t5 = /* @__PURE__ */ jsx(BlockComponent, { blockId: block.id });
		$[7] = block.id;
		$[8] = t5;
	} else t5 = $[8];
	let t6;
	if ($[9] !== t4 || $[10] !== t5) {
		t6 = /* @__PURE__ */ jsx("div", {
			className: "min-h-screen h-screen bg-background text-foreground flex flex-col",
			style: t1,
			children: /* @__PURE__ */ jsxs("div", {
				className: "container mx-0 max-w-full flex flex-col flex-grow overflow-hidden px-0.5 md:px-2",
				children: [t2, /* @__PURE__ */ jsx(NestedBlockContextProvider, {
					overrides: t4,
					children: t5
				})]
			})
		});
		$[9] = t4;
		$[10] = t5;
		$[11] = t6;
	} else t6 = $[11];
	return t6;
}
TopLevelRenderer.canRender = ({ context }) => !!(context && context.layoutBoundary && !context.panelId);
TopLevelRenderer.priority = () => 20;
//#endregion
export { TopLevelRenderer };

//# sourceMappingURL=TopLevelRenderer.js.map