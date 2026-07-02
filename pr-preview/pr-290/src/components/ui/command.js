import { __exportAll } from "../../../_virtual/_rolldown/runtime.js";
import { cn } from "../../lib/utils.js";
import { Search } from "../../../node_modules/lucide-react/dist/esm/icons/search.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog.js";
import { _e } from "../../../node_modules/cmdk/dist/index.js";
import "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/ui/command.tsx
var command_exports = /* @__PURE__ */ __exportAll({
	Command: () => Command,
	CommandDialog: () => CommandDialog,
	CommandEmpty: () => CommandEmpty,
	CommandGroup: () => CommandGroup,
	CommandInput: () => CommandInput,
	CommandItem: () => CommandItem,
	CommandList: () => CommandList,
	CommandSeparator: () => CommandSeparator,
	CommandShortcut: () => CommandShortcut
});
var Command = (t0) => {
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
		t1 = cn("flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx(_e, {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
Command.displayName = _e.displayName;
var commandDialogClassName = "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5";
var CommandDialog = (t0) => {
	const $ = c(32);
	let children;
	let commandProps;
	let contentClassName;
	let props;
	let t1;
	let t2;
	if ($[0] !== t0) {
		({children, title: t1, description: t2, contentClassName, commandProps, ...props} = t0);
		$[0] = t0;
		$[1] = children;
		$[2] = commandProps;
		$[3] = contentClassName;
		$[4] = props;
		$[5] = t1;
		$[6] = t2;
	} else {
		children = $[1];
		commandProps = $[2];
		contentClassName = $[3];
		props = $[4];
		t1 = $[5];
		t2 = $[6];
	}
	const title = t1 === void 0 ? "Command palette" : t1;
	const description = t2 === void 0 ? "Search for a command to run." : t2;
	let t3;
	if ($[7] !== commandProps) {
		t3 = commandProps ?? {};
		$[7] = commandProps;
		$[8] = t3;
	} else t3 = $[8];
	let commandClassName;
	let rootCommandProps;
	if ($[9] !== t3) {
		({className: commandClassName, ...rootCommandProps} = t3);
		$[9] = t3;
		$[10] = commandClassName;
		$[11] = rootCommandProps;
	} else {
		commandClassName = $[10];
		rootCommandProps = $[11];
	}
	let t4;
	if ($[12] !== contentClassName) {
		t4 = cn("overflow-hidden p-0", contentClassName);
		$[12] = contentClassName;
		$[13] = t4;
	} else t4 = $[13];
	let t5;
	if ($[14] !== title) {
		t5 = /* @__PURE__ */ jsx(DialogTitle, {
			className: "sr-only",
			children: title
		});
		$[14] = title;
		$[15] = t5;
	} else t5 = $[15];
	let t6;
	if ($[16] !== description) {
		t6 = /* @__PURE__ */ jsx(DialogDescription, {
			className: "sr-only",
			children: description
		});
		$[16] = description;
		$[17] = t6;
	} else t6 = $[17];
	let t7;
	if ($[18] !== commandClassName) {
		t7 = cn(commandDialogClassName, commandClassName);
		$[18] = commandClassName;
		$[19] = t7;
	} else t7 = $[19];
	let t8;
	if ($[20] !== children || $[21] !== rootCommandProps || $[22] !== t7) {
		t8 = /* @__PURE__ */ jsx(Command, {
			...rootCommandProps,
			className: t7,
			children
		});
		$[20] = children;
		$[21] = rootCommandProps;
		$[22] = t7;
		$[23] = t8;
	} else t8 = $[23];
	let t9;
	if ($[24] !== t4 || $[25] !== t5 || $[26] !== t6 || $[27] !== t8) {
		t9 = /* @__PURE__ */ jsxs(DialogContent, {
			className: t4,
			children: [
				t5,
				t6,
				t8
			]
		});
		$[24] = t4;
		$[25] = t5;
		$[26] = t6;
		$[27] = t8;
		$[28] = t9;
	} else t9 = $[28];
	let t10;
	if ($[29] !== props || $[30] !== t9) {
		t10 = /* @__PURE__ */ jsx(Dialog, {
			...props,
			children: t9
		});
		$[29] = props;
		$[30] = t9;
		$[31] = t10;
	} else t10 = $[31];
	return t10;
};
var CommandInput = (t0) => {
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
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = /* @__PURE__ */ jsx(Search, { className: "mr-2 h-4 w-4 shrink-0 opacity-50" });
		$[3] = t1;
	} else t1 = $[3];
	let t2;
	if ($[4] !== className) {
		t2 = cn("flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50", className);
		$[4] = className;
		$[5] = t2;
	} else t2 = $[5];
	let t3;
	if ($[6] !== props || $[7] !== t2) {
		t3 = /* @__PURE__ */ jsxs("div", {
			className: "flex items-center border-b px-3",
			"cmdk-input-wrapper": "",
			children: [t1, /* @__PURE__ */ jsx(_e.Input, {
				className: t2,
				...props
			})]
		});
		$[6] = props;
		$[7] = t2;
		$[8] = t3;
	} else t3 = $[8];
	return t3;
};
CommandInput.displayName = _e.Input.displayName;
var CommandList = (t0) => {
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
		t1 = cn("max-h-[300px] overflow-y-auto overflow-x-hidden", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx(_e.List, {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
CommandList.displayName = _e.List.displayName;
var CommandEmpty = (props) => {
	const $ = c(2);
	let t0;
	if ($[0] !== props) {
		t0 = /* @__PURE__ */ jsx(_e.Empty, {
			className: "py-6 text-center text-sm",
			...props
		});
		$[0] = props;
		$[1] = t0;
	} else t0 = $[1];
	return t0;
};
CommandEmpty.displayName = _e.Empty.displayName;
var CommandGroup = (t0) => {
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
		t1 = cn("overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx(_e.Group, {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
CommandGroup.displayName = _e.Group.displayName;
var CommandSeparator = (t0) => {
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
		t1 = cn("-mx-1 h-px bg-border", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx(_e.Separator, {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
CommandSeparator.displayName = _e.Separator.displayName;
var CommandItem = (t0) => {
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
		t1 = cn("relative flex cursor-default gap-2 select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx(_e.Item, {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
CommandItem.displayName = _e.Item.displayName;
var CommandShortcut = (t0) => {
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
CommandShortcut.displayName = "CommandShortcut";
//#endregion
export { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut, command_exports };

//# sourceMappingURL=command.js.map