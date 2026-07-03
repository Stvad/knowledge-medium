import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/util/suspense.tsx
var SuspenseFallback = () => {
	const $ = c(1);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = /* @__PURE__ */ jsx("div", { children: "Loading..." });
		$[0] = t0;
	} else t0 = $[0];
	return t0;
};
//#endregion
export { SuspenseFallback };

//# sourceMappingURL=suspense.js.map