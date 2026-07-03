"use client";
import { __exportAll } from "../../../_virtual/_rolldown/runtime.js";
import { cn } from "../../lib/utils.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { Close, Content, Description, Overlay, Portal, Root, Title, Trigger } from "../../../node_modules/@radix-ui/react-dialog/dist/index.js";
import "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/ui/dialog.tsx
var dialog_exports = /* @__PURE__ */ __exportAll({
	Dialog: () => Dialog,
	DialogClose: () => DialogClose,
	DialogContent: () => DialogContent,
	DialogDescription: () => DialogDescription,
	DialogFooter: () => DialogFooter,
	DialogHeader: () => DialogHeader,
	DialogOverlay: () => DialogOverlay,
	DialogPortal: () => DialogPortal,
	DialogTitle: () => DialogTitle,
	DialogTrigger: () => DialogTrigger
});
var Dialog = Root;
var DialogTrigger = Trigger;
var DialogPortal = Portal;
var DialogClose = Close;
var DialogOverlay = (t0) => {
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
		t1 = cn("fixed inset-0 z-50 bg-black/80", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx(Overlay, {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
DialogOverlay.displayName = Overlay.displayName;
var DialogContent = (t0) => {
	const $ = c(17);
	let children;
	let className;
	let props;
	let t1;
	if ($[0] !== t0) {
		({className, children, hideOverlay: t1, ...props} = t0);
		$[0] = t0;
		$[1] = children;
		$[2] = className;
		$[3] = props;
		$[4] = t1;
	} else {
		children = $[1];
		className = $[2];
		props = $[3];
		t1 = $[4];
	}
	const hideOverlay = t1 === void 0 ? false : t1;
	let t2;
	if ($[5] !== hideOverlay) {
		t2 = !hideOverlay && /* @__PURE__ */ jsx(DialogOverlay, {});
		$[5] = hideOverlay;
		$[6] = t2;
	} else t2 = $[6];
	let t3;
	if ($[7] !== className) {
		t3 = cn("fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg sm:rounded-lg", className);
		$[7] = className;
		$[8] = t3;
	} else t3 = $[8];
	let t4;
	if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = /* @__PURE__ */ jsxs(Close, {
			className: "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground",
			children: [/* @__PURE__ */ jsx(X, { className: "h-4 w-4" }), /* @__PURE__ */ jsx("span", {
				className: "sr-only",
				children: "Close"
			})]
		});
		$[9] = t4;
	} else t4 = $[9];
	let t5;
	if ($[10] !== children || $[11] !== props || $[12] !== t3) {
		t5 = /* @__PURE__ */ jsxs(Content, {
			className: t3,
			...props,
			children: [children, t4]
		});
		$[10] = children;
		$[11] = props;
		$[12] = t3;
		$[13] = t5;
	} else t5 = $[13];
	let t6;
	if ($[14] !== t2 || $[15] !== t5) {
		t6 = /* @__PURE__ */ jsxs(DialogPortal, { children: [t2, t5] });
		$[14] = t2;
		$[15] = t5;
		$[16] = t6;
	} else t6 = $[16];
	return t6;
};
DialogContent.displayName = Content.displayName;
var DialogHeader = (t0) => {
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
		t1 = cn("flex flex-col space-y-1.5 text-center sm:text-left", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx("div", {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
DialogHeader.displayName = "DialogHeader";
var DialogFooter = (t0) => {
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
		t1 = cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx("div", {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
DialogFooter.displayName = "DialogFooter";
var DialogTitle = (t0) => {
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
		t1 = cn("text-lg font-semibold leading-none tracking-tight", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx(Title, {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
DialogTitle.displayName = Title.displayName;
var DialogDescription = (t0) => {
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
		t1 = cn("text-sm text-muted-foreground", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx(Description, {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
DialogDescription.displayName = Description.displayName;
//#endregion
export { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger, dialog_exports };

//# sourceMappingURL=dialog.js.map