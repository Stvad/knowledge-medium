import { BlockRefAncestorsContext } from "./cycleGuardContext.js";
import { useContext } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/references/cycleGuard.tsx
var BlockRefAncestorsProvider = (t0) => {
	const $ = c(6);
	const { ancestor, children } = t0;
	const parent = useContext(BlockRefAncestorsContext);
	let next;
	if ($[0] !== ancestor || $[1] !== parent) {
		next = new Set(parent);
		next.add(ancestor);
		$[0] = ancestor;
		$[1] = parent;
		$[2] = next;
	} else next = $[2];
	const value = next;
	let t1;
	if ($[3] !== children || $[4] !== value) {
		t1 = /* @__PURE__ */ jsx(BlockRefAncestorsContext, {
			value,
			children
		});
		$[3] = children;
		$[4] = value;
		$[5] = t1;
	} else t1 = $[5];
	return t1;
};
//#endregion
export { BlockRefAncestorsProvider };

//# sourceMappingURL=cycleGuard.js.map