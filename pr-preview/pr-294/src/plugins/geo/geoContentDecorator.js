import "./blockTypes.js";
import { MapView } from "./MapView.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/geo/geoContentDecorator.tsx
var GeoMapDecorator = (t0) => {
	const $ = c(16);
	const { block, Inner, kind } = t0;
	if (kind === "place") {
		let t1;
		if ($[0] !== block.id) {
			t1 = /* @__PURE__ */ jsx(MapView, {
				rootBlockId: block.id,
				className: "h-56 w-full overflow-hidden rounded-md border",
				defaultZoom: 15
			});
			$[0] = block.id;
			$[1] = t1;
		} else t1 = $[1];
		let t2;
		if ($[2] !== Inner || $[3] !== block) {
			t2 = /* @__PURE__ */ jsx(Inner, { block });
			$[2] = Inner;
			$[3] = block;
			$[4] = t2;
		} else t2 = $[4];
		let t3;
		if ($[5] !== t1 || $[6] !== t2) {
			t3 = /* @__PURE__ */ jsxs("div", {
				className: "flex w-full flex-col gap-3",
				children: [t1, t2]
			});
			$[5] = t1;
			$[6] = t2;
			$[7] = t3;
		} else t3 = $[7];
		return t3;
	}
	let t1;
	if ($[8] !== Inner || $[9] !== block) {
		t1 = /* @__PURE__ */ jsx(Inner, { block });
		$[8] = Inner;
		$[9] = block;
		$[10] = t1;
	} else t1 = $[10];
	let t2;
	if ($[11] !== block.id) {
		t2 = /* @__PURE__ */ jsx(MapView, { rootBlockId: block.id });
		$[11] = block.id;
		$[12] = t2;
	} else t2 = $[12];
	let t3;
	if ($[13] !== t1 || $[14] !== t2) {
		t3 = /* @__PURE__ */ jsxs("div", {
			className: "flex w-full flex-col gap-3",
			children: [t1, t2]
		});
		$[13] = t1;
		$[14] = t2;
		$[15] = t3;
	} else t3 = $[15];
	return t3;
};
var cache = /* @__PURE__ */ new WeakMap();
var decorateWith = (kind) => (inner) => {
	let entry = cache.get(inner);
	if (!entry) {
		entry = {};
		cache.set(inner, entry);
	}
	const existing = entry[kind];
	if (existing) return existing;
	const Decorated = (t0) => {
		const $ = c(2);
		const { block } = t0;
		let t1;
		if ($[0] !== block) {
			t1 = /* @__PURE__ */ jsx(GeoMapDecorator, {
				block,
				Inner: inner,
				kind
			});
			$[0] = block;
			$[1] = t1;
		} else t1 = $[1];
		return t1;
	};
	Decorated.displayName = `WithGeoMap(${kind})`;
	entry[kind] = Decorated;
	return Decorated;
};
var geoContentDecoratorContribution = (ctx) => {
	if (ctx.types.includes("place")) return decorateWith("place");
	if (ctx.types.includes("map")) return decorateWith("map");
	return null;
};
//#endregion
export { geoContentDecoratorContribution };

//# sourceMappingURL=geoContentDecorator.js.map