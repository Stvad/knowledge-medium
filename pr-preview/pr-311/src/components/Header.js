import { headerItemsFacet } from "../extensions/core.js";
import { useAppRuntime } from "../extensions/runtimeContext.js";
import { ExtensionRenderBoundary } from "../extensions/ExtensionRenderBoundary.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/Header.tsx
var HeaderRegion = (t0) => {
	const $ = c(5);
	const { items, className: t1 } = t0;
	const t2 = `flex min-w-0 items-center gap-1 sm:gap-2 md:gap-4 ${t1 === void 0 ? "" : t1}`;
	let t3;
	if ($[0] !== items) {
		t3 = items.map(_temp);
		$[0] = items;
		$[1] = t3;
	} else t3 = $[1];
	let t4;
	if ($[2] !== t2 || $[3] !== t3) {
		t4 = /* @__PURE__ */ jsx("div", {
			className: t2,
			children: t3
		});
		$[2] = t2;
		$[3] = t3;
		$[4] = t4;
	} else t4 = $[4];
	return t4;
};
function Header() {
	const $ = c(10);
	const runtime = useAppRuntime();
	let startItems;
	let t0;
	if ($[0] !== runtime) {
		const items = runtime.read(headerItemsFacet);
		startItems = items.filter(_temp2);
		t0 = items.filter(_temp3);
		$[0] = runtime;
		$[1] = startItems;
		$[2] = t0;
	} else {
		startItems = $[1];
		t0 = $[2];
	}
	const endItems = t0;
	let t1;
	if ($[3] !== startItems) {
		t1 = /* @__PURE__ */ jsx(HeaderRegion, {
			items: startItems,
			className: "shrink-0 md:flex-1 md:basis-40"
		});
		$[3] = startItems;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== endItems) {
		t2 = /* @__PURE__ */ jsx(HeaderRegion, {
			items: endItems,
			className: "ml-auto flex-1 justify-end overflow-hidden md:ml-0 md:max-w-full md:flex-none md:flex-wrap"
		});
		$[5] = endItems;
		$[6] = t2;
	} else t2 = $[6];
	let t3;
	if ($[7] !== t1 || $[8] !== t2) {
		t3 = /* @__PURE__ */ jsxs("div", {
			className: "flex flex-nowrap items-center gap-x-1 px-2 py-1 sm:gap-x-2 sm:py-2 md:flex-wrap md:justify-between md:gap-x-4 md:gap-y-2 md:px-0",
			children: [t1, t2]
		});
		$[7] = t1;
		$[8] = t2;
		$[9] = t3;
	} else t3 = $[9];
	return t3;
}
function _temp3(item_0) {
	return item_0.region === "end";
}
function _temp2(item) {
	return item.region === "start";
}
function _temp(t0) {
	const { id, component: Component } = t0;
	return /* @__PURE__ */ jsx(ExtensionRenderBoundary, { children: /* @__PURE__ */ jsx(Component, {}) }, id);
}
//#endregion
export { Header };

//# sourceMappingURL=Header.js.map