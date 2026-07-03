import { Search } from "../../../node_modules/lucide-react/dist/esm/icons/search.js";
import { Kbd } from "../../components/ui/kbd.js";
import { findReplaceToggle } from "./toggleStore.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/find-replace/HeaderItem.tsx
var getModKey = () => navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";
function FindReplaceHeaderItem() {
	const $ = c(2);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = /* @__PURE__ */ jsx(Search, { className: "h-4 w-4" });
		$[0] = t0;
	} else t0 = $[0];
	let t1;
	if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = /* @__PURE__ */ jsxs("button", {
			className: "inline-flex h-7 w-7 items-center justify-center gap-1 rounded-md p-0 text-sm text-muted-foreground transition-colors hover:text-foreground sm:h-8 sm:w-auto sm:px-1.5",
			onClick: _temp,
			title: "Find and replace",
			"aria-label": "Find and replace",
			children: [t0, /* @__PURE__ */ jsxs(Kbd, {
				className: "hidden sm:inline-flex",
				children: [getModKey(), "⇧F"]
			})]
		});
		$[1] = t1;
	} else t1 = $[1];
	return t1;
}
function _temp() {
	return findReplaceToggle.toggle();
}
//#endregion
export { FindReplaceHeaderItem };

//# sourceMappingURL=HeaderItem.js.map