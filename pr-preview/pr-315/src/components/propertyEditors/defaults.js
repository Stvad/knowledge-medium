import { ChangeScope } from "../../data/api/changeScope.js";
import { codecs } from "../../data/api/codecs.js";
import "../../data/api/index.js";
import { Block } from "../../data/block.js";
import { Input } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { Plus } from "../../../node_modules/lucide-react/dist/esm/icons/plus.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { usePropertyEditingActivation } from "../propertyPanel/usePropertyEditingActivation.js";
import { Checkbox } from "../ui/checkbox.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/propertyEditors/defaults.tsx
/**
* Property editor resolution helpers.
*
* The lookup chain is:
*   1. Resolve the schema by name.
*   2. Resolve an exact `PropertyEditorOverride.Editor`.
*   3. Resolve a fallback editor contribution by matching the schema/codec.
*   4. Use that fallback editor for primitive codec shapes too.
*
* Unknown properties synthesize a degraded fallback schema from the encoded JSON shape
* and run through the same fallback editor chain.
*/
var INLINE_INPUT_CLASS = "h-7 min-w-0 border-transparent bg-transparent px-0 text-sm shadow-none placeholder:text-muted-foreground/55 focus-visible:border-transparent focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-60";
var readOnlyForBlock = (block) => block instanceof Block && block.repo.isReadOnly;
var useTextDraft = (committedValue) => {
	const $ = c(9);
	let t0;
	if ($[0] !== committedValue) {
		t0 = {
			committedValue,
			draft: committedValue,
			dirty: false
		};
		$[0] = committedValue;
		$[1] = t0;
	} else t0 = $[1];
	const [state, setState] = useState(t0);
	let current = state;
	if (state.committedValue !== committedValue) {
		let t1;
		if ($[2] !== committedValue || $[3] !== state) {
			t1 = state.dirty && state.draft !== committedValue ? {
				...state,
				committedValue
			} : {
				committedValue,
				draft: committedValue,
				dirty: false
			};
			$[2] = committedValue;
			$[3] = state;
			$[4] = t1;
		} else t1 = $[4];
		current = t1;
		setState(current);
	}
	let t1;
	if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = (next) => {
			setState((prev) => ({
				...prev,
				draft: next,
				dirty: next !== prev.committedValue
			}));
		};
		$[5] = t1;
	} else t1 = $[5];
	const setDraft = t1;
	let t2;
	if ($[6] !== current.dirty || $[7] !== current.draft) {
		t2 = {
			draft: current.draft,
			dirty: current.dirty,
			setDraft
		};
		$[6] = current.dirty;
		$[7] = current.draft;
		$[8] = t2;
	} else t2 = $[8];
	return t2;
};
function DraftInput(t0) {
	const $ = c(33);
	let block;
	let committedValue;
	let disabled;
	let onCommit;
	let onKeyDown;
	let props;
	let t1;
	if ($[0] !== t0) {
		({committedValue, block, disabled, onCommit, onKeyDown, readOnly: t1, ...props} = t0);
		$[0] = t0;
		$[1] = block;
		$[2] = committedValue;
		$[3] = disabled;
		$[4] = onCommit;
		$[5] = onKeyDown;
		$[6] = props;
		$[7] = t1;
	} else {
		block = $[1];
		committedValue = $[2];
		disabled = $[3];
		onCommit = $[4];
		onKeyDown = $[5];
		props = $[6];
		t1 = $[7];
	}
	const readOnly = t1 === void 0 ? false : t1;
	const { draft, dirty, setDraft } = useTextDraft(committedValue);
	const focusHandlers = usePropertyEditingActivation(block);
	const locked = readOnly || disabled === true;
	let t2;
	if ($[8] !== committedValue || $[9] !== dirty || $[10] !== locked || $[11] !== onCommit) {
		t2 = (text) => {
			if (locked) return;
			if (!dirty && text === committedValue) return;
			onCommit(text);
		};
		$[8] = committedValue;
		$[9] = dirty;
		$[10] = locked;
		$[11] = onCommit;
		$[12] = t2;
	} else t2 = $[12];
	const commit = t2;
	let t3;
	if ($[13] !== focusHandlers) {
		t3 = (event) => {
			focusHandlers.onFocus(event);
		};
		$[13] = focusHandlers;
		$[14] = t3;
	} else t3 = $[14];
	const handleFocus = t3;
	let t4;
	if ($[15] !== commit || $[16] !== focusHandlers) {
		t4 = (event_0) => {
			commit(event_0.currentTarget.value);
			focusHandlers.onBlur();
		};
		$[15] = commit;
		$[16] = focusHandlers;
		$[17] = t4;
	} else t4 = $[17];
	const handleBlur = t4;
	let t5;
	if ($[18] !== commit || $[19] !== onKeyDown) {
		t5 = (event_1) => {
			if (event_1.key === "Enter") {
				event_1.preventDefault();
				commit(event_1.currentTarget.value);
			}
			onKeyDown?.(event_1);
		};
		$[18] = commit;
		$[19] = onKeyDown;
		$[20] = t5;
	} else t5 = $[20];
	const handleKeyDown = t5;
	let t6;
	if ($[21] !== locked || $[22] !== setDraft) {
		t6 = (event_2) => {
			if (!locked) setDraft(event_2.target.value);
		};
		$[21] = locked;
		$[22] = setDraft;
		$[23] = t6;
	} else t6 = $[23];
	let t7;
	if ($[24] !== disabled || $[25] !== draft || $[26] !== handleBlur || $[27] !== handleFocus || $[28] !== handleKeyDown || $[29] !== props || $[30] !== readOnly || $[31] !== t6) {
		t7 = /* @__PURE__ */ jsx(Input, {
			...props,
			disabled,
			readOnly,
			value: draft,
			onFocus: handleFocus,
			onBlur: handleBlur,
			onChange: t6,
			onKeyDown: handleKeyDown
		});
		$[24] = disabled;
		$[25] = draft;
		$[26] = handleBlur;
		$[27] = handleFocus;
		$[28] = handleKeyDown;
		$[29] = props;
		$[30] = readOnly;
		$[31] = t6;
		$[32] = t7;
	} else t7 = $[32];
	return t7;
}
function UrlPropertyEditor(t0) {
	const $ = c(7);
	const { value, onChange, block } = t0;
	let t1;
	if ($[0] !== block) {
		t1 = readOnlyForBlock(block);
		$[0] = block;
		$[1] = t1;
	} else t1 = $[1];
	const readOnly = t1;
	const text = value === void 0 || value === null ? "" : String(value);
	let t2;
	if ($[2] !== block || $[3] !== onChange || $[4] !== readOnly || $[5] !== text) {
		t2 = /* @__PURE__ */ jsx(DraftInput, {
			type: "url",
			className: INLINE_INPUT_CLASS,
			committedValue: text,
			placeholder: "https://…",
			readOnly,
			block,
			onCommit: onChange
		});
		$[2] = block;
		$[3] = onChange;
		$[4] = readOnly;
		$[5] = text;
		$[6] = t2;
	} else t2 = $[6];
	return t2;
}
function StringPropertyEditor(t0) {
	const $ = c(7);
	const { value, onChange, block } = t0;
	let t1;
	if ($[0] !== block) {
		t1 = readOnlyForBlock(block);
		$[0] = block;
		$[1] = t1;
	} else t1 = $[1];
	const readOnly = t1;
	const text = value === void 0 || value === null ? "" : String(value);
	let t2;
	if ($[2] !== block || $[3] !== onChange || $[4] !== readOnly || $[5] !== text) {
		t2 = /* @__PURE__ */ jsx(DraftInput, {
			className: INLINE_INPUT_CLASS,
			committedValue: text,
			placeholder: "Empty",
			readOnly,
			block,
			onCommit: onChange
		});
		$[2] = block;
		$[3] = onChange;
		$[4] = readOnly;
		$[5] = text;
		$[6] = t2;
	} else t2 = $[6];
	return t2;
}
function NumberPropertyEditor(t0) {
	const $ = c(9);
	const { value, onChange, block } = t0;
	let t1;
	if ($[0] !== block) {
		t1 = readOnlyForBlock(block);
		$[0] = block;
		$[1] = t1;
	} else t1 = $[1];
	const readOnly = t1;
	const text = value === void 0 || value === null ? "" : String(value);
	let t2;
	if ($[2] !== onChange) {
		t2 = (text_0) => {
			const n = parseFloat(text_0);
			onChange(Number.isNaN(n) ? void 0 : n);
		};
		$[2] = onChange;
		$[3] = t2;
	} else t2 = $[3];
	let t3;
	if ($[4] !== block || $[5] !== readOnly || $[6] !== t2 || $[7] !== text) {
		t3 = /* @__PURE__ */ jsx(DraftInput, {
			type: "number",
			className: INLINE_INPUT_CLASS,
			committedValue: text,
			placeholder: "Empty",
			readOnly,
			block,
			onCommit: t2
		});
		$[4] = block;
		$[5] = readOnly;
		$[6] = t2;
		$[7] = text;
		$[8] = t3;
	} else t3 = $[8];
	return t3;
}
function BooleanPropertyEditor(t0) {
	const $ = c(10);
	const { value, onChange, block, schema } = t0;
	let t1;
	if ($[0] !== block) {
		t1 = readOnlyForBlock(block);
		$[0] = block;
		$[1] = t1;
	} else t1 = $[1];
	const readOnly = t1;
	const t2 = schema?.name ? `Toggle ${schema.name}` : "Toggle boolean value";
	const t3 = value === true;
	let t4;
	if ($[2] !== onChange || $[3] !== readOnly) {
		t4 = (checked) => {
			if (!readOnly) onChange(checked === true);
		};
		$[2] = onChange;
		$[3] = readOnly;
		$[4] = t4;
	} else t4 = $[4];
	let t5;
	if ($[5] !== readOnly || $[6] !== t2 || $[7] !== t3 || $[8] !== t4) {
		t5 = /* @__PURE__ */ jsx("div", {
			className: "flex h-7 items-center",
			children: /* @__PURE__ */ jsx(Checkbox, {
				"aria-label": t2,
				checked: t3,
				disabled: readOnly,
				onCheckedChange: t4
			})
		});
		$[5] = readOnly;
		$[6] = t2;
		$[7] = t3;
		$[8] = t4;
		$[9] = t5;
	} else t5 = $[9];
	return t5;
}
function ListItemInput(t0) {
	const $ = c(5);
	const { block, disabled, value, onCommit } = t0;
	let t1;
	if ($[0] !== block || $[1] !== disabled || $[2] !== onCommit || $[3] !== value) {
		t1 = /* @__PURE__ */ jsx(DraftInput, {
			committedValue: value,
			onCommit,
			block,
			className: "h-7 text-xs md:text-sm",
			placeholder: "Enter value...",
			disabled
		});
		$[0] = block;
		$[1] = disabled;
		$[2] = onCommit;
		$[3] = value;
		$[4] = t1;
	} else t1 = $[4];
	return t1;
}
function ListPropertyEditor(t0) {
	const $ = c(19);
	const { value, onChange, block } = t0;
	let t1;
	if ($[0] !== block) {
		t1 = readOnlyForBlock(block);
		$[0] = block;
		$[1] = t1;
	} else t1 = $[1];
	const readOnly = t1;
	const newItemFocusHandlers = usePropertyEditingActivation(block);
	const [newItem, setNewItem] = useState("");
	let addItem;
	let t2;
	let t3;
	if ($[2] !== block || $[3] !== newItem || $[4] !== onChange || $[5] !== readOnly || $[6] !== value) {
		const items = Array.isArray(value) ? value.map(_temp) : [];
		addItem = () => {
			if (newItem.trim()) {
				onChange([...items, newItem.trim()]);
				setNewItem("");
			}
		};
		const removeItem = (index) => {
			onChange(items.filter((_, i) => i !== index));
		};
		const updateItem = (index_0, next) => {
			onChange(items.map((item, i_0) => i_0 === index_0 ? next : item));
		};
		t2 = "space-y-2";
		t3 = items.map((item_0, index_1) => /* @__PURE__ */ jsxs("div", {
			className: "flex gap-2 items-center",
			children: [/* @__PURE__ */ jsx(ListItemInput, {
				block,
				value: item_0,
				disabled: readOnly,
				onCommit: (next_0) => updateItem(index_1, next_0)
			}), !readOnly && /* @__PURE__ */ jsx(Button, {
				variant: "ghost",
				size: "sm",
				onClick: () => removeItem(index_1),
				className: "h-7 w-7 p-0 text-destructive hover:text-destructive",
				children: /* @__PURE__ */ jsx(X, { className: "h-3.5 w-3.5" })
			})]
		}, index_1));
		$[2] = block;
		$[3] = newItem;
		$[4] = onChange;
		$[5] = readOnly;
		$[6] = value;
		$[7] = addItem;
		$[8] = t2;
		$[9] = t3;
	} else {
		addItem = $[7];
		t2 = $[8];
		t3 = $[9];
	}
	let t4;
	if ($[10] !== addItem || $[11] !== newItem || $[12] !== newItemFocusHandlers || $[13] !== readOnly) {
		t4 = !readOnly && /* @__PURE__ */ jsxs("div", {
			className: "flex gap-2 items-center",
			children: [/* @__PURE__ */ jsx(Input, {
				value: newItem,
				onChange: (e) => setNewItem(e.target.value),
				onFocus: newItemFocusHandlers.onFocus,
				onBlur: newItemFocusHandlers.onBlur,
				onKeyDown: (e_0) => {
					if (e_0.key === "Enter") {
						e_0.preventDefault();
						addItem();
					}
				},
				className: "h-7 text-xs md:text-sm",
				placeholder: "Add new item..."
			}), /* @__PURE__ */ jsx(Button, {
				variant: "ghost",
				size: "sm",
				onClick: addItem,
				className: "h-7 w-7 p-0",
				children: /* @__PURE__ */ jsx(Plus, { className: "h-3.5 w-3.5" })
			})]
		});
		$[10] = addItem;
		$[11] = newItem;
		$[12] = newItemFocusHandlers;
		$[13] = readOnly;
		$[14] = t4;
	} else t4 = $[14];
	let t5;
	if ($[15] !== t2 || $[16] !== t3 || $[17] !== t4) {
		t5 = /* @__PURE__ */ jsxs("div", {
			className: t2,
			children: [t3, t4]
		});
		$[15] = t2;
		$[16] = t3;
		$[17] = t4;
		$[18] = t5;
	} else t5 = $[18];
	return t5;
}
function _temp(v) {
	return typeof v === "string" ? v : String(v);
}
function ObjectPropertyEditor(t0) {
	const $ = c(11);
	const { value, onChange, block } = t0;
	let t1;
	if ($[0] !== block) {
		t1 = readOnlyForBlock(block);
		$[0] = block;
		$[1] = t1;
	} else t1 = $[1];
	const readOnly = t1;
	let t2;
	if ($[2] !== value) {
		t2 = JSON.stringify(value ?? {});
		$[2] = value;
		$[3] = t2;
	} else t2 = $[3];
	const text = t2;
	let t3;
	if ($[4] !== onChange) {
		t3 = (text_0) => {
			try {
				onChange(JSON.parse(text_0));
			} catch {}
		};
		$[4] = onChange;
		$[5] = t3;
	} else t3 = $[5];
	let t4;
	if ($[6] !== block || $[7] !== readOnly || $[8] !== t3 || $[9] !== text) {
		t4 = /* @__PURE__ */ jsx(DraftInput, {
			className: `${INLINE_INPUT_CLASS} font-mono`,
			committedValue: text,
			placeholder: "Empty",
			readOnly,
			block,
			onCommit: t3
		});
		$[6] = block;
		$[7] = readOnly;
		$[8] = t3;
		$[9] = text;
		$[10] = t4;
	} else t4 = $[10];
	return t4;
}
function DatePropertyEditor(t0) {
	const $ = c(11);
	const { value, onChange, block } = t0;
	let t1;
	if ($[0] !== block) {
		t1 = readOnlyForBlock(block);
		$[0] = block;
		$[1] = t1;
	} else t1 = $[1];
	const readOnly = t1;
	let t2;
	if ($[2] !== value) {
		t2 = value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === "string" && value ? value.slice(0, 10) : "";
		$[2] = value;
		$[3] = t2;
	} else t2 = $[3];
	const isoString = t2;
	let t3;
	if ($[4] !== onChange) {
		t3 = (text) => {
			onChange(text ? new Date(text) : void 0);
		};
		$[4] = onChange;
		$[5] = t3;
	} else t3 = $[5];
	let t4;
	if ($[6] !== block || $[7] !== isoString || $[8] !== readOnly || $[9] !== t3) {
		t4 = /* @__PURE__ */ jsx(DraftInput, {
			type: "date",
			className: INLINE_INPUT_CLASS,
			committedValue: isoString,
			placeholder: "Empty",
			readOnly,
			block,
			onCommit: t3
		});
		$[6] = block;
		$[7] = isoString;
		$[8] = readOnly;
		$[9] = t3;
		$[10] = t4;
	} else t4 = $[10];
	return t4;
}
/** Default value used when the property panel adds a new property of a
*  given primitive type. Returns undefined for codec types without a
*  natural empty value (e.g. unknown plugin types) — the caller picks
*  a sensible fallback. */
var defaultValueForShape = (type) => {
	switch (type) {
		case "string": return "";
		case "number": return 0;
		case "boolean": return false;
		case "list": return [];
		case "object": return {};
		case "date": return;
		case "url": return "";
		default: return "";
	}
};
/** Lossy type inference used when no schema is registered for a
*  property name. Inspects the encoded JSON value and returns one of
*  the known JSON-primitive types (`'string' | 'number' | 'boolean' |
*  'list' | 'object'`) so the panel can still render an editor. */
var inferTypeFromValue = (value) => {
	if (Array.isArray(value)) return "list";
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "number") return "number";
	if (typeof value === "object" && value !== null) return "object";
	return "string";
};
/** Build a degraded fallback `PropertySchema` for a property whose
*  actual schema isn't registered. Used at read sites by the unknown-
*  schema renderer fallback path: when the registry doesn't know the
*  name, we still need *some* schema reference so the panel can run
*  encoded JSON through a codec and pick an editor. The resulting
*  schema is intentionally type-loose (`unsafeIdentity`) and never
*  persisted — it exists only to keep the read path rendering. */
var degradedFallbackSchema = (name, type) => ({
	name,
	codec: type === "list" ? codecs.list(codecs.unsafeIdentity()) : codecs.unsafeIdentity(type),
	defaultValue: defaultValueForShape(type),
	changeScope: ChangeScope.BlockDefault
});
/** Resolution chain (per user-defined-properties §1-edit):
*
*    1. Look up the schema in `repo.propertySchemas` by `name`.
*    2. Look up any per-name override in `repo.propertyEditorOverrides`.
*    3. If schema is known → use the override `Editor` if any, else
*       the `ValuePreset.Editor` matching `codec.type`.
*    4. If schema is unknown → infer a primitive type from the JSON
*       value, build an ad-hoc schema, and use the matching preset's
*       editor (or fall through to undefined if no preset matches).
*/
var resolvePropertyDisplay = (args) => {
	const known = args.schemas.get(args.name);
	if (known) {
		const ui = args.uis.get(args.name);
		const preset = args.presets.get(known.codec.type);
		return {
			schema: known,
			shape: known.codec.type,
			Editor: ui?.Editor ?? preset?.Editor,
			Glyph: ui?.Glyph ?? preset?.Glyph,
			isKnown: true
		};
	}
	const shape = inferTypeFromValue(args.encodedValue);
	const schema = degradedFallbackSchema(args.name, shape);
	const preset = args.presets.get(schema.codec.type);
	return {
		schema,
		shape,
		Editor: preset?.Editor,
		Glyph: preset?.Glyph,
		isKnown: false
	};
};
//#endregion
export { BooleanPropertyEditor, DatePropertyEditor, ListPropertyEditor, NumberPropertyEditor, ObjectPropertyEditor, StringPropertyEditor, UrlPropertyEditor, defaultValueForShape, degradedFallbackSchema, inferTypeFromValue, resolvePropertyDisplay };

//# sourceMappingURL=defaults.js.map