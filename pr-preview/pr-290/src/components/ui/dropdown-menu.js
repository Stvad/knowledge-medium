"use client";
import { __exportAll } from "../../../_virtual/_rolldown/runtime.js";
import { cn } from "../../lib/utils.js";
import { Check } from "../../../node_modules/lucide-react/dist/esm/icons/check.js";
import { ChevronRight } from "../../../node_modules/lucide-react/dist/esm/icons/chevron-right.js";
import { Circle } from "../../../node_modules/lucide-react/dist/esm/icons/circle.js";
import { CheckboxItem2, Content2, Group2, Item2, ItemIndicator2, Label2, Portal2, RadioGroup2, RadioItem2, Root2, Separator2, Sub2, SubContent2, SubTrigger2, Trigger } from "../../../node_modules/@radix-ui/react-dropdown-menu/dist/index.js";
import "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/ui/dropdown-menu.tsx
var dropdown_menu_exports = /* @__PURE__ */ __exportAll({
	DropdownMenu: () => DropdownMenu,
	DropdownMenuCheckboxItem: () => DropdownMenuCheckboxItem,
	DropdownMenuContent: () => DropdownMenuContent,
	DropdownMenuGroup: () => DropdownMenuGroup,
	DropdownMenuItem: () => DropdownMenuItem,
	DropdownMenuLabel: () => DropdownMenuLabel,
	DropdownMenuPortal: () => DropdownMenuPortal,
	DropdownMenuRadioGroup: () => DropdownMenuRadioGroup,
	DropdownMenuRadioItem: () => DropdownMenuRadioItem,
	DropdownMenuSeparator: () => DropdownMenuSeparator,
	DropdownMenuShortcut: () => DropdownMenuShortcut,
	DropdownMenuSub: () => DropdownMenuSub,
	DropdownMenuSubContent: () => DropdownMenuSubContent,
	DropdownMenuSubTrigger: () => DropdownMenuSubTrigger,
	DropdownMenuTrigger: () => DropdownMenuTrigger
});
var DropdownMenu = Root2;
var DropdownMenuTrigger = Trigger;
var DropdownMenuGroup = Group2;
var DropdownMenuPortal = Portal2;
var DropdownMenuSub = Sub2;
var DropdownMenuRadioGroup = RadioGroup2;
var DropdownMenuSubTrigger = (t0) => {
	const $ = c(13);
	let children;
	let className;
	let inset;
	let props;
	if ($[0] !== t0) {
		({className, inset, children, ...props} = t0);
		$[0] = t0;
		$[1] = children;
		$[2] = className;
		$[3] = inset;
		$[4] = props;
	} else {
		children = $[1];
		className = $[2];
		inset = $[3];
		props = $[4];
	}
	const t1 = inset && "pl-8";
	let t2;
	if ($[5] !== className || $[6] !== t1) {
		t2 = cn("flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[state=open]:bg-accent", t1, className);
		$[5] = className;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	let t3;
	if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = /* @__PURE__ */ jsx(ChevronRight, { className: "ml-auto h-4 w-4" });
		$[8] = t3;
	} else t3 = $[8];
	let t4;
	if ($[9] !== children || $[10] !== props || $[11] !== t2) {
		t4 = /* @__PURE__ */ jsxs(SubTrigger2, {
			className: t2,
			...props,
			children: [children, t3]
		});
		$[9] = children;
		$[10] = props;
		$[11] = t2;
		$[12] = t4;
	} else t4 = $[12];
	return t4;
};
DropdownMenuSubTrigger.displayName = SubTrigger2.displayName;
var DropdownMenuSubContent = (t0) => {
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
		t1 = cn("z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx(SubContent2, {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
DropdownMenuSubContent.displayName = SubContent2.displayName;
var DropdownMenuContent = (t0) => {
	const $ = c(10);
	let className;
	let props;
	let t1;
	if ($[0] !== t0) {
		({className, sideOffset: t1, ...props} = t0);
		$[0] = t0;
		$[1] = className;
		$[2] = props;
		$[3] = t1;
	} else {
		className = $[1];
		props = $[2];
		t1 = $[3];
	}
	const sideOffset = t1 === void 0 ? 4 : t1;
	let t2;
	if ($[4] !== className) {
		t2 = cn("z-50 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95", className);
		$[4] = className;
		$[5] = t2;
	} else t2 = $[5];
	let t3;
	if ($[6] !== props || $[7] !== sideOffset || $[8] !== t2) {
		t3 = /* @__PURE__ */ jsx(Portal2, { children: /* @__PURE__ */ jsx(Content2, {
			sideOffset,
			className: t2,
			...props
		}) });
		$[6] = props;
		$[7] = sideOffset;
		$[8] = t2;
		$[9] = t3;
	} else t3 = $[9];
	return t3;
};
DropdownMenuContent.displayName = Content2.displayName;
var DropdownMenuItem = (t0) => {
	const $ = c(10);
	let className;
	let inset;
	let props;
	if ($[0] !== t0) {
		({className, inset, ...props} = t0);
		$[0] = t0;
		$[1] = className;
		$[2] = inset;
		$[3] = props;
	} else {
		className = $[1];
		inset = $[2];
		props = $[3];
	}
	const t1 = inset && "pl-8";
	let t2;
	if ($[4] !== className || $[5] !== t1) {
		t2 = cn("relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50", t1, className);
		$[4] = className;
		$[5] = t1;
		$[6] = t2;
	} else t2 = $[6];
	let t3;
	if ($[7] !== props || $[8] !== t2) {
		t3 = /* @__PURE__ */ jsx(Item2, {
			className: t2,
			...props
		});
		$[7] = props;
		$[8] = t2;
		$[9] = t3;
	} else t3 = $[9];
	return t3;
};
DropdownMenuItem.displayName = Item2.displayName;
var DropdownMenuCheckboxItem = (t0) => {
	const $ = c(13);
	let checked;
	let children;
	let className;
	let props;
	if ($[0] !== t0) {
		({className, children, checked, ...props} = t0);
		$[0] = t0;
		$[1] = checked;
		$[2] = children;
		$[3] = className;
		$[4] = props;
	} else {
		checked = $[1];
		children = $[2];
		className = $[3];
		props = $[4];
	}
	let t1;
	if ($[5] !== className) {
		t1 = cn("relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className);
		$[5] = className;
		$[6] = t1;
	} else t1 = $[6];
	let t2;
	if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = /* @__PURE__ */ jsx("span", {
			className: "absolute left-2 flex h-3.5 w-3.5 items-center justify-center",
			children: /* @__PURE__ */ jsx(ItemIndicator2, { children: /* @__PURE__ */ jsx(Check, { className: "h-4 w-4" }) })
		});
		$[7] = t2;
	} else t2 = $[7];
	let t3;
	if ($[8] !== checked || $[9] !== children || $[10] !== props || $[11] !== t1) {
		t3 = /* @__PURE__ */ jsxs(CheckboxItem2, {
			className: t1,
			checked,
			...props,
			children: [t2, children]
		});
		$[8] = checked;
		$[9] = children;
		$[10] = props;
		$[11] = t1;
		$[12] = t3;
	} else t3 = $[12];
	return t3;
};
DropdownMenuCheckboxItem.displayName = CheckboxItem2.displayName;
var DropdownMenuRadioItem = (t0) => {
	const $ = c(11);
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
		t1 = cn("relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className);
		$[4] = className;
		$[5] = t1;
	} else t1 = $[5];
	let t2;
	if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = /* @__PURE__ */ jsx("span", {
			className: "absolute left-2 flex h-3.5 w-3.5 items-center justify-center",
			children: /* @__PURE__ */ jsx(ItemIndicator2, { children: /* @__PURE__ */ jsx(Circle, { className: "h-2 w-2 fill-current" }) })
		});
		$[6] = t2;
	} else t2 = $[6];
	let t3;
	if ($[7] !== children || $[8] !== props || $[9] !== t1) {
		t3 = /* @__PURE__ */ jsxs(RadioItem2, {
			className: t1,
			...props,
			children: [t2, children]
		});
		$[7] = children;
		$[8] = props;
		$[9] = t1;
		$[10] = t3;
	} else t3 = $[10];
	return t3;
};
DropdownMenuRadioItem.displayName = RadioItem2.displayName;
var DropdownMenuLabel = (t0) => {
	const $ = c(10);
	let className;
	let inset;
	let props;
	if ($[0] !== t0) {
		({className, inset, ...props} = t0);
		$[0] = t0;
		$[1] = className;
		$[2] = inset;
		$[3] = props;
	} else {
		className = $[1];
		inset = $[2];
		props = $[3];
	}
	const t1 = inset && "pl-8";
	let t2;
	if ($[4] !== className || $[5] !== t1) {
		t2 = cn("px-2 py-1.5 text-sm font-semibold", t1, className);
		$[4] = className;
		$[5] = t1;
		$[6] = t2;
	} else t2 = $[6];
	let t3;
	if ($[7] !== props || $[8] !== t2) {
		t3 = /* @__PURE__ */ jsx(Label2, {
			className: t2,
			...props
		});
		$[7] = props;
		$[8] = t2;
		$[9] = t3;
	} else t3 = $[9];
	return t3;
};
DropdownMenuLabel.displayName = Label2.displayName;
var DropdownMenuSeparator = (t0) => {
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
		t1 = cn("-mx-1 my-1 h-px bg-muted", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx(Separator2, {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
DropdownMenuSeparator.displayName = Separator2.displayName;
var DropdownMenuShortcut = (t0) => {
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
		t1 = cn("ml-auto text-xs tracking-widest opacity-60", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx("span", {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
DropdownMenuShortcut.displayName = "DropdownMenuShortcut";
//#endregion
export { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, dropdown_menu_exports };

//# sourceMappingURL=dropdown-menu.js.map