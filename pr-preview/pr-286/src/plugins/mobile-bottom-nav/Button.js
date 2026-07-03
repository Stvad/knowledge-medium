import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/mobile-bottom-nav/Button.tsx
function MobileBottomNavButton(t0) {
	const $ = c(7);
	const { label, icon: Icon, onClick, disabled: t1 } = t0;
	const disabled = t1 === void 0 ? false : t1;
	let t2;
	if ($[0] !== Icon) {
		t2 = /* @__PURE__ */ jsx(Icon, { className: "h-7 w-7 stroke-[1.6]" });
		$[0] = Icon;
		$[1] = t2;
	} else t2 = $[1];
	let t3;
	if ($[2] !== disabled || $[3] !== label || $[4] !== onClick || $[5] !== t2) {
		t3 = /* @__PURE__ */ jsx("button", {
			type: "button",
			className: "flex h-14 flex-1 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-accent active:text-foreground disabled:pointer-events-none disabled:opacity-35",
			onClick,
			disabled,
			title: label,
			"aria-label": label,
			children: t2
		});
		$[2] = disabled;
		$[3] = label;
		$[4] = onClick;
		$[5] = t2;
		$[6] = t3;
	} else t3 = $[6];
	return t3;
}
//#endregion
export { MobileBottomNavButton };

//# sourceMappingURL=Button.js.map