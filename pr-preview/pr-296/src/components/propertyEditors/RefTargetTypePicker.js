import { typesFacet } from "../../data/facets.js";
import { Input } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { Plus } from "../../../node_modules/lucide-react/dist/esm/icons/plus.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/propertyEditors/RefTargetTypePicker.tsx
/** Config editor for ref / refList presets. Lets the user constrain
*  the property to one or more block types — empty list means "any
*  type accepted." Mounted inside the property-schema block renderer
*  (the side panel reached via the row's glyph button). */
function RefTargetTypePicker(t0) {
	const $ = c(49);
	const { value, onChange } = t0;
	const runtime = useAppRuntime();
	let t1;
	if ($[0] !== runtime) {
		t1 = runtime.read(typesFacet);
		$[0] = runtime;
		$[1] = t1;
	} else t1 = $[1];
	const types = t1;
	let t2;
	if ($[2] !== types) {
		t2 = (typeId) => (types.get(typeId)?.label ?? "").trim() || typeId;
		$[2] = types;
		$[3] = t2;
	} else t2 = $[3];
	const labelFor = t2;
	let t3;
	if ($[4] !== types) {
		t3 = Array.from(types.values()).map(_temp).sort(_temp2);
		$[4] = types;
		$[5] = t3;
	} else t3 = $[5];
	const options = t3;
	let map;
	if ($[6] !== options) {
		map = /* @__PURE__ */ new Map();
		for (const opt of options) map.set(opt.label.toLowerCase(), opt.id);
		$[6] = options;
		$[7] = map;
	} else map = $[7];
	const idForLabel = map;
	let t4;
	if ($[8] !== value.targetTypes) {
		t4 = Array.isArray(value.targetTypes) ? value.targetTypes : [];
		$[8] = value.targetTypes;
		$[9] = t4;
	} else t4 = $[9];
	const targets = t4;
	let t5;
	if ($[10] !== onChange || $[11] !== value) {
		t5 = (next) => {
			const deduped = Array.from(new Set(next.map(_temp3).filter(Boolean)));
			onChange({
				...value,
				targetTypes: deduped.length > 0 ? deduped : void 0
			});
		};
		$[10] = onChange;
		$[11] = value;
		$[12] = t5;
	} else t5 = $[12];
	const setTargets = t5;
	const [draft, setDraft] = useState("");
	let t6;
	if ($[13] !== draft || $[14] !== idForLabel || $[15] !== setTargets || $[16] !== targets) {
		t6 = () => {
			const trimmed = draft.trim();
			if (!trimmed) return;
			const id = idForLabel.get(trimmed.toLowerCase()) ?? trimmed;
			setTargets([...targets, id]);
			setDraft("");
		};
		$[13] = draft;
		$[14] = idForLabel;
		$[15] = setTargets;
		$[16] = targets;
		$[17] = t6;
	} else t6 = $[17];
	const addDraft = t6;
	let t7;
	if ($[18] !== setTargets || $[19] !== targets) {
		t7 = (typeId_0) => setTargets(targets.filter((t_1) => t_1 !== typeId_0));
		$[18] = setTargets;
		$[19] = targets;
		$[20] = t7;
	} else t7 = $[20];
	const remove = t7;
	let t8;
	if ($[21] !== addDraft) {
		t8 = (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				addDraft();
			}
		};
		$[21] = addDraft;
		$[22] = t8;
	} else t8 = $[22];
	const onKeyDown = t8;
	let t9;
	if ($[23] !== labelFor || $[24] !== targets) {
		t9 = targets.length === 0 ? "Accepts any block type. Add one or more types to constrain." : `Accepts only: ${targets.map(labelFor).join(", ")}`;
		$[23] = labelFor;
		$[24] = targets;
		$[25] = t9;
	} else t9 = $[25];
	let t10;
	if ($[26] !== t9) {
		t10 = /* @__PURE__ */ jsx("div", {
			className: "text-xs text-muted-foreground",
			children: t9
		});
		$[26] = t9;
		$[27] = t10;
	} else t10 = $[27];
	let t11;
	if ($[28] !== labelFor || $[29] !== remove || $[30] !== targets) {
		t11 = targets.length > 0 && /* @__PURE__ */ jsx("div", {
			className: "flex flex-wrap gap-1.5",
			children: targets.map((typeId_1) => /* @__PURE__ */ jsxs("span", {
				className: "inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs",
				children: [labelFor(typeId_1), /* @__PURE__ */ jsx("button", {
					type: "button",
					"aria-label": `Remove target type ${labelFor(typeId_1)}`,
					className: "text-muted-foreground hover:text-foreground",
					onClick: () => remove(typeId_1),
					children: /* @__PURE__ */ jsx(X, { className: "h-3 w-3" })
				})]
			}, typeId_1))
		});
		$[28] = labelFor;
		$[29] = remove;
		$[30] = targets;
		$[31] = t11;
	} else t11 = $[31];
	let t12;
	if ($[32] === Symbol.for("react.memo_cache_sentinel")) {
		t12 = (event_0) => setDraft(event_0.target.value);
		$[32] = t12;
	} else t12 = $[32];
	let t13;
	if ($[33] !== draft || $[34] !== onKeyDown) {
		t13 = /* @__PURE__ */ jsx(Input, {
			list: "ref-target-type-options",
			placeholder: "Add a block type…",
			value: draft,
			onChange: t12,
			onKeyDown,
			className: "h-7 text-xs md:text-sm"
		});
		$[33] = draft;
		$[34] = onKeyDown;
		$[35] = t13;
	} else t13 = $[35];
	let t14;
	if ($[36] === Symbol.for("react.memo_cache_sentinel")) {
		t14 = /* @__PURE__ */ jsx(Plus, { className: "h-3.5 w-3.5" });
		$[36] = t14;
	} else t14 = $[36];
	let t15;
	if ($[37] !== addDraft) {
		t15 = /* @__PURE__ */ jsx(Button, {
			variant: "ghost",
			size: "sm",
			onClick: addDraft,
			className: "h-7 w-7 p-0",
			children: t14
		});
		$[37] = addDraft;
		$[38] = t15;
	} else t15 = $[38];
	let t16;
	if ($[39] !== t13 || $[40] !== t15) {
		t16 = /* @__PURE__ */ jsxs("div", {
			className: "flex gap-2 items-center",
			children: [t13, t15]
		});
		$[39] = t13;
		$[40] = t15;
		$[41] = t16;
	} else t16 = $[41];
	let t17;
	if ($[42] !== options) {
		t17 = options.length > 0 && /* @__PURE__ */ jsx("datalist", {
			id: "ref-target-type-options",
			children: options.map(_temp4)
		});
		$[42] = options;
		$[43] = t17;
	} else t17 = $[43];
	let t18;
	if ($[44] !== t10 || $[45] !== t11 || $[46] !== t16 || $[47] !== t17) {
		t18 = /* @__PURE__ */ jsxs("div", {
			className: "space-y-2",
			children: [
				t10,
				t11,
				t16,
				t17
			]
		});
		$[44] = t10;
		$[45] = t11;
		$[46] = t16;
		$[47] = t17;
		$[48] = t18;
	} else t18 = $[48];
	return t18;
}
function _temp4(opt_0) {
	return /* @__PURE__ */ jsx("option", { value: opt_0.label }, opt_0.id);
}
function _temp3(t_0) {
	return t_0.trim();
}
function _temp2(a, b) {
	return a.label.localeCompare(b.label);
}
function _temp(t) {
	return {
		id: t.id,
		label: (t.label ?? "").trim() || t.id
	};
}
//#endregion
export { RefTargetTypePicker };

//# sourceMappingURL=RefTargetTypePicker.js.map