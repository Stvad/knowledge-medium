import { __exportAll } from "../../../_virtual/_rolldown/runtime.js";
import { cn } from "../../lib/utils.js";
import "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/ui/input.tsx
var input_exports = /* @__PURE__ */ __exportAll({ Input: () => Input });
var Input = (t0) => {
	const $ = c(10);
	let className;
	let props;
	let type;
	if ($[0] !== t0) {
		({className, type, ...props} = t0);
		$[0] = t0;
		$[1] = className;
		$[2] = props;
		$[3] = type;
	} else {
		className = $[1];
		props = $[2];
		type = $[3];
	}
	let t1;
	if ($[4] !== className) {
		t1 = cn("flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50", className);
		$[4] = className;
		$[5] = t1;
	} else t1 = $[5];
	let t2;
	if ($[6] !== props || $[7] !== t1 || $[8] !== type) {
		t2 = /* @__PURE__ */ jsx("input", {
			type,
			className: t1,
			...props
		});
		$[6] = props;
		$[7] = t1;
		$[8] = type;
		$[9] = t2;
	} else t2 = $[9];
	return t2;
};
Input.displayName = "Input";
//#endregion
export { Input, input_exports };

//# sourceMappingURL=input.js.map