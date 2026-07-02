import { isEnumCodec } from "../../data/api/codecs.js";
import "../../data/api/index.js";
import { Block } from "../../data/block.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/propertyEditors/SelectPropertyEditor.tsx
/** Editor for `enum` codec properties — a plain `<select>` whose options
*  ride on the codec (`codecs.enum(options)`), so a single component
*  serves every enum property without per-name wiring. Resolved by the
*  `enum` ValuePreset keyed on `codec.type`. */
var EMPTY_OPTIONS = [];
function SelectPropertyEditor(t0) {
	const $ = c(20);
	const { value, onChange, block, schema } = t0;
	const readOnly = block instanceof Block && block.repo.isReadOnly;
	const options = schema && isEnumCodec(schema.codec) ? schema.codec.options : EMPTY_OPTIONS;
	const current = typeof value === "string" ? value : "";
	let t1;
	if ($[0] !== current || $[1] !== options) {
		let t2;
		if ($[3] !== current) {
			t2 = (option) => option.value === current;
			$[3] = current;
			$[4] = t2;
		} else t2 = $[4];
		t1 = options.some(t2);
		$[0] = current;
		$[1] = options;
		$[2] = t1;
	} else t1 = $[2];
	const inOptions = t1;
	const t2 = schema?.name ? `Select ${schema.name}` : "Select value";
	let t3;
	if ($[5] !== onChange || $[6] !== readOnly) {
		t3 = (event) => {
			if (!readOnly) onChange(event.target.value);
		};
		$[5] = onChange;
		$[6] = readOnly;
		$[7] = t3;
	} else t3 = $[7];
	let t4;
	if ($[8] !== current || $[9] !== inOptions) {
		t4 = !inOptions && /* @__PURE__ */ jsx("option", {
			value: current,
			children: current === "" ? "— Select —" : `${current} (unknown)`
		});
		$[8] = current;
		$[9] = inOptions;
		$[10] = t4;
	} else t4 = $[10];
	let t5;
	if ($[11] !== options) {
		t5 = options.map(_temp);
		$[11] = options;
		$[12] = t5;
	} else t5 = $[12];
	let t6;
	if ($[13] !== current || $[14] !== readOnly || $[15] !== t2 || $[16] !== t3 || $[17] !== t4 || $[18] !== t5) {
		t6 = /* @__PURE__ */ jsx("div", {
			className: "flex h-7 items-center",
			children: /* @__PURE__ */ jsxs("select", {
				className: "h-7 min-w-0 max-w-full rounded-md border bg-background px-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60",
				value: current,
				disabled: readOnly,
				"aria-label": t2,
				onChange: t3,
				children: [t4, t5]
			})
		});
		$[13] = current;
		$[14] = readOnly;
		$[15] = t2;
		$[16] = t3;
		$[17] = t4;
		$[18] = t5;
		$[19] = t6;
	} else t6 = $[19];
	return t6;
}
function _temp(option_0) {
	return /* @__PURE__ */ jsx("option", {
		value: option_0.value,
		children: option_0.label
	}, option_0.value);
}
//#endregion
export { SelectPropertyEditor };

//# sourceMappingURL=SelectPropertyEditor.js.map