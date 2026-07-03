import { __exportAll } from "../../../_virtual/_rolldown/runtime.js";
import { cn } from "../../lib/utils.js";
import { Check } from "../../../node_modules/lucide-react/dist/esm/icons/check.js";
import { ChevronRight } from "../../../node_modules/lucide-react/dist/esm/icons/chevron-right.js";
import { Circle } from "../../../node_modules/lucide-react/dist/esm/icons/circle.js";
import { CheckboxItem2, Content2, Group2, Item2, ItemIndicator2, Label2, Portal2, RadioGroup2, RadioItem2, Root2, Separator2, Sub2, SubContent2, SubTrigger2, Trigger } from "../../../node_modules/@radix-ui/react-context-menu/dist/index.js";
import "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/ui/context-menu.tsx
var context_menu_exports = /* @__PURE__ */ __exportAll({
	ContextMenu: () => ContextMenu,
	ContextMenuCheckboxItem: () => ContextMenuCheckboxItem,
	ContextMenuContent: () => ContextMenuContent,
	ContextMenuGroup: () => ContextMenuGroup,
	ContextMenuItem: () => ContextMenuItem,
	ContextMenuLabel: () => ContextMenuLabel,
	ContextMenuPortal: () => ContextMenuPortal,
	ContextMenuRadioGroup: () => ContextMenuRadioGroup,
	ContextMenuRadioItem: () => ContextMenuRadioItem,
	ContextMenuSeparator: () => ContextMenuSeparator,
	ContextMenuShortcut: () => ContextMenuShortcut,
	ContextMenuSub: () => ContextMenuSub,
	ContextMenuSubContent: () => ContextMenuSubContent,
	ContextMenuSubTrigger: () => ContextMenuSubTrigger,
	ContextMenuTrigger: () => ContextMenuTrigger
});
var ContextMenu = Root2;
var ContextMenuTrigger = Trigger;
var ContextMenuGroup = Group2;
var ContextMenuPortal = Portal2;
var ContextMenuSub = Sub2;
var ContextMenuRadioGroup = RadioGroup2;
var ContextMenuSubTrigger = (t0) => {
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
		t2 = cn("flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground", t1, className);
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
ContextMenuSubTrigger.displayName = SubTrigger2.displayName;
var ContextMenuSubContent = (t0) => {
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
		t1 = cn("z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2", className);
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
ContextMenuSubContent.displayName = SubContent2.displayName;
var ContextMenuContent = (t0) => {
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
		t1 = cn("z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx(Portal2, { children: /* @__PURE__ */ jsx(Content2, {
			className: t1,
			...props
		}) });
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
ContextMenuContent.displayName = Content2.displayName;
var ContextMenuItem = (t0) => {
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
		t2 = cn("relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50", t1, className);
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
ContextMenuItem.displayName = Item2.displayName;
var ContextMenuCheckboxItem = (t0) => {
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
		t1 = cn("relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className);
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
ContextMenuCheckboxItem.displayName = CheckboxItem2.displayName;
var ContextMenuRadioItem = (t0) => {
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
		t1 = cn("relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className);
		$[4] = className;
		$[5] = t1;
	} else t1 = $[5];
	let t2;
	if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = /* @__PURE__ */ jsx("span", {
			className: "absolute left-2 flex h-3.5 w-3.5 items-center justify-center",
			children: /* @__PURE__ */ jsx(ItemIndicator2, { children: /* @__PURE__ */ jsx(Circle, { className: "h-4 w-4 fill-current" }) })
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
ContextMenuRadioItem.displayName = RadioItem2.displayName;
var ContextMenuLabel = (t0) => {
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
		t2 = cn("px-2 py-1.5 text-sm font-semibold text-foreground", t1, className);
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
ContextMenuLabel.displayName = Label2.displayName;
var ContextMenuSeparator = (t0) => {
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
		t1 = cn("-mx-1 my-1 h-px bg-border", className);
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
ContextMenuSeparator.displayName = Separator2.displayName;
var ContextMenuShortcut = (t0) => {
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
		t1 = cn("ml-auto text-xs tracking-widest text-muted-foreground", className);
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
ContextMenuShortcut.displayName = "ContextMenuShortcut";
//#endregion
export { ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuLabel, ContextMenuPortal, ContextMenuRadioGroup, ContextMenuRadioItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger, context_menu_exports };

//# sourceMappingURL=context-menu.js.map