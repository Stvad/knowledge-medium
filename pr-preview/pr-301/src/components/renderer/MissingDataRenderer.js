import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/renderer/MissingDataRenderer.tsx
var MissingDataRenderer = (t0) => {
	const $ = c(2);
	const { block } = t0;
	let t1;
	if ($[0] !== block) {
		t1 = block?.peek() === void 0 ? /* @__PURE__ */ jsx("div", {
			className: "text-gray-500 text-sm",
			children: "Loading block..."
		}) : null;
		$[0] = block;
		$[1] = t1;
	} else t1 = $[1];
	return t1;
};
MissingDataRenderer.canRender = ({ block }) => !block?.peek();
MissingDataRenderer.priority = () => 1;
//#endregion
export { MissingDataRenderer };

//# sourceMappingURL=MissingDataRenderer.js.map