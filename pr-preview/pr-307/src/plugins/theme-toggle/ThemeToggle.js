"use client";
import { Button } from "../../components/ui/button.js";
import { Moon } from "../../../node_modules/lucide-react/dist/esm/icons/moon.js";
import { Sun } from "../../../node_modules/lucide-react/dist/esm/icons/sun.js";
import { applyTheme, getCurrentTheme, toggleTheme } from "./theme.js";
import * as React$1 from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/theme-toggle/ThemeToggle.tsx
function ThemeToggle() {
	const $ = c(9);
	const [theme, setTheme] = React$1.useState(_temp);
	let t0;
	let t1;
	if ($[0] !== theme) {
		t0 = () => {
			applyTheme(theme);
		};
		t1 = [theme];
		$[0] = theme;
		$[1] = t0;
		$[2] = t1;
	} else {
		t0 = $[1];
		t1 = $[2];
	}
	React$1.useEffect(t0, t1);
	let t2;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = () => setTheme(toggleTheme());
		$[3] = t2;
	} else t2 = $[3];
	const t3 = `Theme: ${theme.label}`;
	let t4;
	let t5;
	let t6;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = /* @__PURE__ */ jsx(Sun, { className: "h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" });
		t5 = /* @__PURE__ */ jsx(Moon, { className: "absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" });
		t6 = /* @__PURE__ */ jsx("span", {
			className: "sr-only",
			children: "Toggle theme"
		});
		$[4] = t4;
		$[5] = t5;
		$[6] = t6;
	} else {
		t4 = $[4];
		t5 = $[5];
		t6 = $[6];
	}
	let t7;
	if ($[7] !== t3) {
		t7 = /* @__PURE__ */ jsxs(Button, {
			variant: "outline",
			size: "icon",
			onClick: t2,
			title: t3,
			children: [
				t4,
				t5,
				t6
			]
		});
		$[7] = t3;
		$[8] = t7;
	} else t7 = $[8];
	return t7;
}
function _temp() {
	return typeof window === "undefined" ? {
		id: "light",
		label: "Light",
		mode: "light"
	} : getCurrentTheme();
}
//#endregion
export { ThemeToggle };

//# sourceMappingURL=ThemeToggle.js.map