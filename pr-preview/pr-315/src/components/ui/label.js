import { __exportAll } from "../../../_virtual/_rolldown/runtime.js";
import { cn } from "../../lib/utils.js";
import { cva } from "../../../node_modules/class-variance-authority/dist/index.js";
import { Root } from "../../../node_modules/@radix-ui/react-label/dist/index.js";
import "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/ui/label.tsx
var label_exports = /* @__PURE__ */ __exportAll({ Label: () => Label });
var labelVariants = cva("text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70");
var Label = (t0) => {
	const $ = c(8);
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
		t1 = cn(labelVariants(), className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx(Root, {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
Label.displayName = Root.displayName;
//#endregion
export { Label, label_exports };

//# sourceMappingURL=label.js.map