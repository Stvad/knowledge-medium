import { c } from "react/compiler-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/backlinks-view/BacklinksEmptyState.tsx
var BacklinksEmptyState = (t0) => {
	const $ = c(3);
	const { controls } = t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = /* @__PURE__ */ jsx("div", {
			className: "mt-4 pt-3 border-t border-border text-xs text-muted-foreground",
			children: "No backlinks."
		});
		$[0] = t1;
	} else t1 = $[0];
	let t2;
	if ($[1] !== controls) {
		t2 = /* @__PURE__ */ jsxs(Fragment, { children: [controls, t1] });
		$[1] = controls;
		$[2] = t2;
	} else t2 = $[2];
	return t2;
};
//#endregion
export { BacklinksEmptyState };

//# sourceMappingURL=BacklinksEmptyState.js.map