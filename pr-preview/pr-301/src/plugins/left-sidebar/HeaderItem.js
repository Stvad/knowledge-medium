import { PanelLeftOpen } from "../../../node_modules/lucide-react/dist/esm/icons/panel-left-open.js";
import { leftSidebarToggle } from "./toggleStore.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/left-sidebar/HeaderItem.tsx
function LeftSidebarHeaderItem() {
	const $ = c(1);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = /* @__PURE__ */ jsx("button", {
			type: "button",
			className: "hidden h-8 items-center justify-center rounded-md px-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground md:inline-flex",
			onClick: _temp,
			title: "Sidebar",
			"aria-label": "Open sidebar",
			children: /* @__PURE__ */ jsx(PanelLeftOpen, { className: "h-5 w-5" })
		});
		$[0] = t0;
	} else t0 = $[0];
	return t0;
}
function _temp() {
	return leftSidebarToggle.toggle();
}
//#endregion
export { LeftSidebarHeaderItem };

//# sourceMappingURL=HeaderItem.js.map