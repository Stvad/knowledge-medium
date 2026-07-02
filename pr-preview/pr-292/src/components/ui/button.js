import { __exportAll } from "../../../_virtual/_rolldown/runtime.js";
import { cn } from "../../lib/utils.js";
import { Slot } from "../../../node_modules/@radix-ui/react-slot/dist/index.js";
import { cva } from "../../../node_modules/class-variance-authority/dist/index.js";
import "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/ui/button.tsx
var button_exports = /* @__PURE__ */ __exportAll({ Button: () => Button });
var buttonVariants = cva("inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50", {
	variants: {
		variant: {
			default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
			destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
			outline: "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
			secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
			ghost: "hover:bg-accent hover:text-accent-foreground",
			link: "text-primary underline-offset-4 hover:underline"
		},
		size: {
			default: "h-9 px-4 py-2",
			sm: "h-8 rounded-md px-3 text-xs",
			lg: "h-10 rounded-md px-8",
			icon: "h-9 w-9"
		}
	},
	defaultVariants: {
		variant: "default",
		size: "default"
	}
});
var Button = (t0) => {
	const $ = c(14);
	let className;
	let props;
	let size;
	let t1;
	let variant;
	if ($[0] !== t0) {
		({className, variant, size, asChild: t1, ...props} = t0);
		$[0] = t0;
		$[1] = className;
		$[2] = props;
		$[3] = size;
		$[4] = t1;
		$[5] = variant;
	} else {
		className = $[1];
		props = $[2];
		size = $[3];
		t1 = $[4];
		variant = $[5];
	}
	const Comp = (t1 === void 0 ? false : t1) ? Slot : "button";
	let t2;
	if ($[6] !== className || $[7] !== size || $[8] !== variant) {
		t2 = cn(buttonVariants({
			variant,
			size,
			className
		}));
		$[6] = className;
		$[7] = size;
		$[8] = variant;
		$[9] = t2;
	} else t2 = $[9];
	let t3;
	if ($[10] !== Comp || $[11] !== props || $[12] !== t2) {
		t3 = /* @__PURE__ */ jsx(Comp, {
			className: t2,
			...props
		});
		$[10] = Comp;
		$[11] = props;
		$[12] = t2;
		$[13] = t3;
	} else t3 = $[13];
	return t3;
};
Button.displayName = "Button";
//#endregion
export { Button, button_exports };

//# sourceMappingURL=button.js.map