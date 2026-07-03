import { __exportAll } from "../../../_virtual/_rolldown/runtime.js";
import { cn } from "../../lib/utils.js";
import { Check } from "../../../node_modules/lucide-react/dist/esm/icons/check.js";
import { Checkbox as Checkbox$1, CheckboxIndicator } from "../../../node_modules/@radix-ui/react-checkbox/dist/index.js";
import "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/ui/checkbox.tsx
var checkbox_exports = /* @__PURE__ */ __exportAll({ Checkbox: () => Checkbox });
var Checkbox = (t0) => {
	const $ = c(9);
	let className;
	let props;
	if ($[0] !== t0) {
		({className, ...props} = t0);
		$[0] = t0;
		$[1] = className;
		$[2] = props;
	} else {
		className = $[1];
		props = $[2];
	}
	let t1;
	if ($[3] !== className) {
		t1 = cn("peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = /* @__PURE__ */ jsx(CheckboxIndicator, {
			className: cn("flex items-center justify-center text-current"),
			children: /* @__PURE__ */ jsx(Check, { className: "h-4 w-4" })
		});
		$[5] = t2;
	} else t2 = $[5];
	let t3;
	if ($[6] !== props || $[7] !== t1) {
		t3 = /* @__PURE__ */ jsx(Checkbox$1, {
			className: t1,
			...props,
			children: t2
		});
		$[6] = props;
		$[7] = t1;
		$[8] = t3;
	} else t3 = $[8];
	return t3;
};
Checkbox.displayName = Checkbox$1.displayName;
//#endregion
export { Checkbox, checkbox_exports };

//# sourceMappingURL=checkbox.js.map