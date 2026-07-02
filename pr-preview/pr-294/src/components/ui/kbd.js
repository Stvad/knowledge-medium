import { __exportAll } from "../../../_virtual/_rolldown/runtime.js";
import { cn } from "../../lib/utils.js";
import "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/ui/kbd.tsx
var kbd_exports = /* @__PURE__ */ __exportAll({ Kbd: () => Kbd });
var Kbd = (t0) => {
	const $ = c(10);
	let children;
	let className;
	let props;
	if ($[0] !== t0) {
		({className, children, ...props} = t0);
		$[0] = t0;
		$[1] = children;
		$[2] = className;
		$[3] = props;
	} else {
		children = $[1];
		className = $[2];
		props = $[3];
	}
	let t1;
	if ($[4] !== className) {
		t1 = cn("pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100", className);
		$[4] = className;
		$[5] = t1;
	} else t1 = $[5];
	let t2;
	if ($[6] !== children || $[7] !== props || $[8] !== t1) {
		t2 = /* @__PURE__ */ jsx("kbd", {
			className: t1,
			...props,
			children
		});
		$[6] = children;
		$[7] = props;
		$[8] = t1;
		$[9] = t2;
	} else t2 = $[9];
	return t2;
};
//#endregion
export { Kbd, kbd_exports };

//# sourceMappingURL=kbd.js.map