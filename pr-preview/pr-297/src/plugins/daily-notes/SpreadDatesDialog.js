import { Input } from "../../components/ui/input.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Label } from "../../components/ui/label.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/daily-notes/SpreadDatesDialog.tsx
var DEFAULT_SPREAD_DAYS = 15;
var parseDays = (value) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 1) return null;
	return Math.floor(parsed);
};
var SpreadDatesDialog = (t0) => {
	const $ = c(20);
	const { defaultDays: t1, resolve, cancel } = t0;
	const [days, setDays] = useState(String(t1 === void 0 ? DEFAULT_SPREAD_DAYS : t1));
	const [error, setError] = useState(null);
	let t2;
	if ($[0] !== days || $[1] !== resolve) {
		t2 = (event) => {
			event.preventDefault();
			const dayCount = parseDays(days);
			if (dayCount === null) {
				setError("Choose at least 1 day");
				return;
			}
			resolve({ days: dayCount });
		};
		$[0] = days;
		$[1] = resolve;
		$[2] = t2;
	} else t2 = $[2];
	const handleSubmit = t2;
	let t3;
	if ($[3] !== cancel) {
		t3 = (next) => {
			if (!next) cancel();
		};
		$[3] = cancel;
		$[4] = t3;
	} else t3 = $[4];
	let t4;
	if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = /* @__PURE__ */ jsx(DialogHeader, { children: /* @__PURE__ */ jsx(DialogTitle, { children: "Spread dates" }) });
		$[5] = t4;
	} else t4 = $[5];
	let t5;
	if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
		t5 = /* @__PURE__ */ jsx(Label, {
			htmlFor: "spread-dates-days",
			children: "Days"
		});
		$[6] = t5;
	} else t5 = $[6];
	let t6;
	if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
		t6 = (event_0) => setDays(event_0.target.value);
		$[7] = t6;
	} else t6 = $[7];
	let t7;
	if ($[8] !== days) {
		t7 = /* @__PURE__ */ jsxs("div", {
			className: "space-y-2",
			children: [t5, /* @__PURE__ */ jsx(Input, {
				id: "spread-dates-days",
				type: "number",
				min: 1,
				step: 1,
				inputMode: "numeric",
				value: days,
				onChange: t6
			})]
		});
		$[8] = days;
		$[9] = t7;
	} else t7 = $[9];
	let t8;
	if ($[10] !== error) {
		t8 = error && /* @__PURE__ */ jsx("p", {
			className: "text-sm text-destructive",
			children: error
		});
		$[10] = error;
		$[11] = t8;
	} else t8 = $[11];
	let t9;
	if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
		t9 = /* @__PURE__ */ jsx(DialogFooter, { children: /* @__PURE__ */ jsx(Button, {
			type: "submit",
			children: "Spread"
		}) });
		$[12] = t9;
	} else t9 = $[12];
	let t10;
	if ($[13] !== handleSubmit || $[14] !== t7 || $[15] !== t8) {
		t10 = /* @__PURE__ */ jsxs(DialogContent, {
			className: "max-w-sm",
			children: [t4, /* @__PURE__ */ jsxs("form", {
				onSubmit: handleSubmit,
				className: "space-y-4",
				children: [
					t7,
					t8,
					t9
				]
			})]
		});
		$[13] = handleSubmit;
		$[14] = t7;
		$[15] = t8;
		$[16] = t10;
	} else t10 = $[16];
	let t11;
	if ($[17] !== t10 || $[18] !== t3) {
		t11 = /* @__PURE__ */ jsx(Dialog, {
			open: true,
			onOpenChange: t3,
			children: t10
		});
		$[17] = t10;
		$[18] = t3;
		$[19] = t11;
	} else t11 = $[19];
	return t11;
};
//#endregion
export { SpreadDatesDialog };

//# sourceMappingURL=SpreadDatesDialog.js.map