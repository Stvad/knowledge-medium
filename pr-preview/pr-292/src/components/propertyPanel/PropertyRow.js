import { isRefCodec, isRefListCodec } from "../../data/api/codecs.js";
import "../../data/api/index.js";
import { Input } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { Trash2 } from "../../../node_modules/lucide-react/dist/esm/icons/trash-2.js";
import { propertyShapeLabel } from "./shapes.js";
import { PropertyShapeButton } from "./shapeUi.js";
import { usePropertyEditingActivation } from "./usePropertyEditingActivation.js";
import { PROPERTY_ROW_GRID_STYLE } from "./layout.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/propertyPanel/PropertyRow.tsx
var formatRawJsonValue = (value) => {
	try {
		const json = JSON.stringify(value);
		return json === void 0 ? String(value) : json;
	} catch {
		return String(value);
	}
};
function RawJsonValue(t0) {
	const $ = c(6);
	const { value, reason } = t0;
	if (value === void 0 || value === null) {
		let t1;
		if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
			t1 = /* @__PURE__ */ jsx("div", {
				className: "h-7 truncate py-1 text-sm text-muted-foreground/55",
				children: "Empty"
			});
			$[0] = t1;
		} else t1 = $[0];
		return t1;
	}
	let t1;
	if ($[1] !== value) {
		t1 = formatRawJsonValue(value);
		$[1] = value;
		$[2] = t1;
	} else t1 = $[2];
	const rawJson = t1;
	const t2 = `${reason}; raw JSON value: ${rawJson}`;
	let t3;
	if ($[3] !== rawJson || $[4] !== t2) {
		t3 = /* @__PURE__ */ jsx("div", {
			className: "h-7 truncate py-1 font-mono text-sm text-muted-foreground",
			title: t2,
			children: rawJson
		});
		$[3] = rawJson;
		$[4] = t2;
		$[5] = t3;
	} else t3 = $[5];
	return t3;
}
function PropertyRow(t0) {
	const $ = c(56);
	const { row, block, readOnly, canConfigure, recentlyMaterialized: t1, onNavigate, onConfigure, onChange, onRename, onDelete } = t0;
	const recentlyMaterialized = t1 === void 0 ? false : t1;
	const Editor = row.Editor;
	const rowReadOnly = readOnly;
	const renameAllowed = row.canRename && !rowReadOnly;
	const renameFocusHandlers = usePropertyEditingActivation(block);
	const rowAlignment = isRefCodec(row.schema.codec) || isRefListCodec(row.schema.codec) ? "items-start" : "items-center";
	let t2;
	if ($[0] !== row.shape) {
		t2 = propertyShapeLabel(row.shape);
		$[0] = row.shape;
		$[1] = t2;
	} else t2 = $[1];
	const t3 = row.schemaUnknown ? "schema not registered" : null;
	const t4 = row.decodeFailed ? "decode failed" : null;
	const t5 = row.isHidden ? "hidden field" : null;
	const t6 = row.labelText !== row.name ? row.name : null;
	let t7;
	if ($[2] !== t2 || $[3] !== t3 || $[4] !== t4 || $[5] !== t5 || $[6] !== t6) {
		t7 = [
			t2,
			t3,
			t4,
			t5,
			t6
		].filter(Boolean);
		$[2] = t2;
		$[3] = t3;
		$[4] = t4;
		$[5] = t5;
		$[6] = t6;
		$[7] = t7;
	} else t7 = $[7];
	const hintText = t7.join(" · ");
	const t8 = `group/property-row grid ${rowAlignment} gap-2 border-b border-transparent py-0.5 text-sm hover:border-border/50 focus-within:border-border/70`;
	let t9;
	if ($[8] !== onNavigate) {
		t9 = (event) => {
			if (event.key === "ArrowUp") onNavigate(event, -1);
			if (event.key === "ArrowDown") onNavigate(event, 1);
		};
		$[8] = onNavigate;
		$[9] = t9;
	} else t9 = $[9];
	const t10 = !canConfigure;
	let t11;
	if ($[10] !== onConfigure || $[11] !== row.Glyph || $[12] !== row.decodeFailed || $[13] !== row.labelText || $[14] !== row.schemaUnknown || $[15] !== row.shape || $[16] !== t10) {
		t11 = /* @__PURE__ */ jsx(PropertyShapeButton, {
			shape: row.shape,
			Glyph: row.Glyph,
			label: row.labelText,
			schemaUnknown: row.schemaUnknown,
			decodeFailed: row.decodeFailed,
			disabled: t10,
			onClick: onConfigure
		});
		$[10] = onConfigure;
		$[11] = row.Glyph;
		$[12] = row.decodeFailed;
		$[13] = row.labelText;
		$[14] = row.schemaUnknown;
		$[15] = row.shape;
		$[16] = t10;
		$[17] = t11;
	} else t11 = $[17];
	let t12;
	if ($[18] !== hintText || $[19] !== onRename || $[20] !== renameAllowed || $[21] !== renameFocusHandlers || $[22] !== row.decodeFailed || $[23] !== row.labelText || $[24] !== row.name || $[25] !== row.schemaUnknown) {
		t12 = /* @__PURE__ */ jsx("div", {
			className: "min-w-0 flex-1",
			children: renameAllowed ? /* @__PURE__ */ jsx(Input, {
				className: "h-7 min-w-0 border-transparent bg-transparent px-0 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0",
				defaultValue: row.name,
				"aria-label": `Field ${row.labelText}`,
				"data-property-label": "true",
				title: hintText,
				onKeyDown: (event_0) => {
					if (event_0.key === "Enter" || event_0.key === "Tab") {
						event_0.preventDefault();
						onRename(event_0.currentTarget.value);
					}
				},
				onFocus: renameFocusHandlers.onFocus,
				onBlur: (event_1) => {
					renameFocusHandlers.onBlur();
					onRename(event_1.target.value);
				}
			}) : /* @__PURE__ */ jsxs("div", {
				className: "truncate text-foreground",
				"data-property-label": "true",
				tabIndex: -1,
				title: hintText,
				children: [
					row.labelText,
					row.schemaUnknown && /* @__PURE__ */ jsx("span", {
						className: "ml-1 text-amber-600",
						children: "*"
					}),
					row.decodeFailed && /* @__PURE__ */ jsx("span", {
						className: "ml-1 text-destructive",
						children: "*"
					})
				]
			})
		});
		$[18] = hintText;
		$[19] = onRename;
		$[20] = renameAllowed;
		$[21] = renameFocusHandlers;
		$[22] = row.decodeFailed;
		$[23] = row.labelText;
		$[24] = row.name;
		$[25] = row.schemaUnknown;
		$[26] = t12;
	} else t12 = $[26];
	let t13;
	if ($[27] !== recentlyMaterialized) {
		t13 = recentlyMaterialized && /* @__PURE__ */ jsx("span", {
			className: "shrink-0 rounded-full bg-fuchsia-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-200",
			"data-recently-materialized": "true",
			title: "A schema was just registered for this property — open the side panel to configure type or details.",
			children: "New schema"
		});
		$[27] = recentlyMaterialized;
		$[28] = t13;
	} else t13 = $[28];
	let t14;
	if ($[29] !== t12 || $[30] !== t13) {
		t14 = /* @__PURE__ */ jsxs("div", {
			className: "flex min-w-0 items-center gap-1.5",
			children: [t12, t13]
		});
		$[29] = t12;
		$[30] = t13;
		$[31] = t14;
	} else t14 = $[31];
	let t15;
	if ($[32] !== Editor || $[33] !== block || $[34] !== onChange || $[35] !== row.decodeFailed || $[36] !== row.encodedValue || $[37] !== row.schema || $[38] !== row.value) {
		t15 = /* @__PURE__ */ jsx("div", {
			className: "min-w-0",
			"data-property-value": "true",
			children: Editor !== void 0 && !row.decodeFailed ? /* @__PURE__ */ jsx(Editor, {
				value: row.value,
				onChange,
				block,
				schema: row.schema
			}) : row.decodeFailed ? /* @__PURE__ */ jsx(RawJsonValue, {
				value: row.encodedValue,
				reason: "Decode failed"
			}) : /* @__PURE__ */ jsx(RawJsonValue, {
				value: row.value,
				reason: "No editor registered"
			})
		});
		$[32] = Editor;
		$[33] = block;
		$[34] = onChange;
		$[35] = row.decodeFailed;
		$[36] = row.encodedValue;
		$[37] = row.schema;
		$[38] = row.value;
		$[39] = t15;
	} else t15 = $[39];
	let t16;
	if ($[40] !== onDelete || $[41] !== row.canDelete || $[42] !== row.labelText || $[43] !== rowReadOnly) {
		t16 = !rowReadOnly && row.canDelete && /* @__PURE__ */ jsx(Button, {
			variant: "ghost",
			size: "sm",
			onClick: onDelete,
			title: `Delete ${row.labelText}`,
			className: "h-7 w-7 p-0 text-muted-foreground opacity-0 hover:text-destructive group-hover/property-row:opacity-100 focus-visible:opacity-100",
			children: /* @__PURE__ */ jsx(Trash2, { className: "h-3.5 w-3.5" })
		});
		$[40] = onDelete;
		$[41] = row.canDelete;
		$[42] = row.labelText;
		$[43] = rowReadOnly;
		$[44] = t16;
	} else t16 = $[44];
	let t17;
	if ($[45] !== t16) {
		t17 = /* @__PURE__ */ jsx("div", {
			className: "flex h-7 items-center justify-center",
			"data-property-row-control": "true",
			children: t16
		});
		$[45] = t16;
		$[46] = t17;
	} else t17 = $[46];
	let t18;
	if ($[47] !== block.id || $[48] !== row.name || $[49] !== t11 || $[50] !== t14 || $[51] !== t15 || $[52] !== t17 || $[53] !== t8 || $[54] !== t9) {
		t18 = /* @__PURE__ */ jsxs("div", {
			className: t8,
			style: PROPERTY_ROW_GRID_STYLE,
			"data-property-row": "true",
			"data-block-id": block.id,
			"data-property-name": row.name,
			onKeyDown: t9,
			children: [
				t11,
				t14,
				t15,
				t17
			]
		});
		$[47] = block.id;
		$[48] = row.name;
		$[49] = t11;
		$[50] = t14;
		$[51] = t15;
		$[52] = t17;
		$[53] = t8;
		$[54] = t9;
		$[55] = t18;
	} else t18 = $[55];
	return t18;
}
//#endregion
export { PropertyRow };

//# sourceMappingURL=PropertyRow.js.map