import { cn } from "../lib/utils.js";
import { X } from "../../node_modules/lucide-react/dist/esm/icons/x.js";
import { Close, Content, Overlay, Portal, Root, Title } from "../../node_modules/@radix-ui/react-dialog/dist/index.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/markdown/MarkdownImage.tsx
var MarkdownImage = (t0) => {
	const $ = c(39);
	let alt;
	let className;
	let onClick;
	let rest;
	let src;
	if ($[0] !== t0) {
		const { src: t1, alt: t2, className: t3, onClick: t4, node: _node, ...t5 } = t0;
		src = t1;
		alt = t2;
		className = t3;
		onClick = t4;
		rest = t5;
		$[0] = t0;
		$[1] = alt;
		$[2] = className;
		$[3] = onClick;
		$[4] = rest;
		$[5] = src;
	} else {
		alt = $[1];
		className = $[2];
		onClick = $[3];
		rest = $[4];
		src = $[5];
	}
	const [open, setOpen] = useState(false);
	if (!src) {
		let t1;
		if ($[6] !== alt || $[7] !== className || $[8] !== onClick || $[9] !== rest) {
			t1 = /* @__PURE__ */ jsx("img", {
				alt,
				className,
				onClick,
				...rest
			});
			$[6] = alt;
			$[7] = className;
			$[8] = onClick;
			$[9] = rest;
			$[10] = t1;
		} else t1 = $[10];
		return t1;
	}
	let t1;
	if ($[11] !== onClick) {
		t1 = (event) => {
			onClick?.(event);
			if (event.defaultPrevented) return;
			setOpen(true);
		};
		$[11] = onClick;
		$[12] = t1;
	} else t1 = $[12];
	const handleClick = t1;
	let t2;
	if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = (event_0) => {
			if (event_0.target === event_0.currentTarget) setOpen(false);
		};
		$[13] = t2;
	} else t2 = $[13];
	const handleBackdropClick = t2;
	let t3;
	if ($[14] !== className) {
		t3 = cn("cursor-zoom-in", className);
		$[14] = className;
		$[15] = t3;
	} else t3 = $[15];
	let t4;
	if ($[16] !== alt || $[17] !== handleClick || $[18] !== rest || $[19] !== src || $[20] !== t3) {
		t4 = /* @__PURE__ */ jsx("img", {
			...rest,
			src,
			alt,
			className: t3,
			onClick: handleClick
		});
		$[16] = alt;
		$[17] = handleClick;
		$[18] = rest;
		$[19] = src;
		$[20] = t3;
		$[21] = t4;
	} else t4 = $[21];
	let t5;
	if ($[22] === Symbol.for("react.memo_cache_sentinel")) {
		t5 = /* @__PURE__ */ jsx(Overlay, { className: "fixed inset-0 z-50 bg-black/85" });
		$[22] = t5;
	} else t5 = $[22];
	const t6 = alt || "Image preview";
	let t7;
	if ($[23] !== t6) {
		t7 = /* @__PURE__ */ jsx(Title, {
			className: "sr-only",
			children: t6
		});
		$[23] = t6;
		$[24] = t7;
	} else t7 = $[24];
	let t8;
	if ($[25] === Symbol.for("react.memo_cache_sentinel")) {
		t8 = () => setOpen(false);
		$[25] = t8;
	} else t8 = $[25];
	let t9;
	if ($[26] !== alt || $[27] !== src) {
		t9 = /* @__PURE__ */ jsx("img", {
			src,
			alt,
			className: "max-h-full max-w-full object-contain cursor-zoom-out",
			onClick: t8
		});
		$[26] = alt;
		$[27] = src;
		$[28] = t9;
	} else t9 = $[28];
	let t10;
	if ($[29] === Symbol.for("react.memo_cache_sentinel")) {
		t10 = /* @__PURE__ */ jsx(Close, {
			className: "absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white opacity-80 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/60",
			"aria-label": "Close image preview",
			children: /* @__PURE__ */ jsx(X, { className: "h-5 w-5" })
		});
		$[29] = t10;
	} else t10 = $[29];
	let t11;
	if ($[30] !== t7 || $[31] !== t9) {
		t11 = /* @__PURE__ */ jsxs(Portal, { children: [t5, /* @__PURE__ */ jsxs(Content, {
			className: "fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 outline-none",
			onClick: handleBackdropClick,
			"aria-describedby": void 0,
			children: [
				t7,
				t9,
				t10
			]
		})] });
		$[30] = t7;
		$[31] = t9;
		$[32] = t11;
	} else t11 = $[32];
	let t12;
	if ($[33] !== open || $[34] !== t11) {
		t12 = /* @__PURE__ */ jsx(Root, {
			open,
			onOpenChange: setOpen,
			children: t11
		});
		$[33] = open;
		$[34] = t11;
		$[35] = t12;
	} else t12 = $[35];
	let t13;
	if ($[36] !== t12 || $[37] !== t4) {
		t13 = /* @__PURE__ */ jsxs(Fragment$1, { children: [t4, t12] });
		$[36] = t12;
		$[37] = t4;
		$[38] = t13;
	} else t13 = $[38];
	return t13;
};
//#endregion
export { MarkdownImage };

//# sourceMappingURL=MarkdownImage.js.map