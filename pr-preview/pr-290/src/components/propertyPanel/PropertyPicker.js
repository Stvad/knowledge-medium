import { propertyEditorOverridesFacet, valuePresetsFacet } from "../../data/facets.js";
import { Input } from "../ui/input.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { propertyShapeLabel } from "./shapes.js";
import { PropertyShapeButton, PropertyShapeGlyph } from "./shapeUi.js";
import { selectablePresets } from "../propertyEditors/selectablePresets.js";
import { usePropertySchemas } from "../../hooks/propertySchemas.js";
import { FloatingListbox } from "../ui/floating-listbox.js";
import { useAutocompleteListbox } from "../../hooks/useAutocompleteListbox.js";
import { usePropertyEditingActivation } from "./usePropertyEditingActivation.js";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/components/propertyPanel/PropertyPicker.tsx
/** PropertyPicker — name-autocomplete + glyph-create entry for picking
*  or materializing a property schema. Shared between AddPropertyForm
*  (the block's "+ Field" surface) and BlockTypeBlockRenderer's
*  Properties section. Doesn't know what the caller does with the
*  picked schema; just exposes onAdd (existing schema OR plain
*  {name, presetId}) and onConfigureNewSchema (glyph-click — materialize
*  + open in side panel for further config).
*
*  Layout-free by design: callers wrap it in their own grid/list/etc. */
var DEFAULT_PRESET_ID = "ref";
var FALLBACK_PRESET_ID = "string";
var MAX_SUGGESTIONS = 8;
var filterSuggestions = (query, schemas, uis, presets, excludedNames, filterSchema) => {
	const q = query.trim().toLowerCase();
	const out = [];
	for (const schema of schemas.values()) {
		if (excludedNames.has(schema.name)) continue;
		if (uis.get(schema.name)?.hidden) continue;
		if (q !== "" && !schema.name.toLowerCase().includes(q)) continue;
		if (filterSchema && !filterSchema(schema)) continue;
		out.push({
			schema,
			preset: presets.get(schema.codec.type)
		});
		if (out.length >= MAX_SUGGESTIONS) break;
	}
	return out.sort((a, b) => a.schema.name.localeCompare(b.schema.name));
};
function PropertyPicker({ onAdd, onConfigureNewSchema, excludedNames, filterSchema, placeholder = "Field", inputClassName, autoFocus = false, initialName = "", onEscape, block }) {
	const propertyEditingFocus = usePropertyEditingActivation(block);
	const runtime = useAppRuntime();
	const presets = runtime.read(valuePresetsFacet);
	const uis = runtime.read(propertyEditorOverridesFacet);
	const schemas = usePropertySchemas();
	const presetEntries = useMemo(() => selectablePresets(presets), [presets]);
	const initialPresetId = useMemo(() => {
		if (presets.has("ref")) return "ref";
		if (presets.has("string")) return FALLBACK_PRESET_ID;
		return presetEntries[0]?.id ?? "string";
	}, [presetEntries, presets]);
	const [propertyName, setPropertyName] = useState(initialName);
	const [presetId, setPresetId] = useState(initialPresetId);
	const [suggestionsOpen, setSuggestionsOpen] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const localInputRef = useRef(null);
	const [nameInputEl, setNameInputEl] = useState(null);
	const listboxId = useId();
	const resetActiveIndexRef = useRef(() => {});
	const excludedNamesSet = useMemo(() => new Set(excludedNames ?? []), [excludedNames]);
	const preset = presets.get(presetId);
	const focusNameInput = useCallback(() => {
		const focus = () => {
			localInputRef.current?.focus();
			localInputRef.current?.setSelectionRange(0, localInputRef.current.value.length);
		};
		if (typeof requestAnimationFrame === "undefined") focus();
		else requestAnimationFrame(focus);
	}, []);
	useEffect(() => {
		if (autoFocus) focusNameInput();
	}, [autoFocus, focusNameInput]);
	const suggestions = useMemo(() => filterSuggestions(propertyName, schemas, uis, presets, excludedNamesSet, filterSchema), [
		propertyName,
		schemas,
		uis,
		presets,
		excludedNamesSet,
		filterSchema
	]);
	const reset = useCallback(() => {
		setPropertyName("");
		setPresetId(initialPresetId);
		setSuggestionsOpen(false);
		resetActiveIndexRef.current();
	}, [initialPresetId]);
	const submit = useCallback(async (adopted) => {
		const name = (adopted?.name ?? propertyName).trim();
		if (!name || submitting) return;
		setSubmitting(true);
		try {
			await onAdd(adopted ? {
				adopted,
				name,
				presetId: adopted.codec.type
			} : {
				name,
				presetId
			});
			reset();
		} finally {
			setSubmitting(false);
		}
	}, [
		onAdd,
		presetId,
		propertyName,
		reset,
		submitting
	]);
	const handleGlyphClick = useCallback(async () => {
		const name_0 = propertyName.trim();
		if (!name_0) {
			focusNameInput();
			return;
		}
		if (submitting) return;
		const schema = await onConfigureNewSchema({
			name: name_0,
			presetId
		});
		if (!schema) return;
		submit(schema);
	}, [
		focusNameInput,
		onConfigureNewSchema,
		presetId,
		propertyName,
		submit,
		submitting
	]);
	const showSuggestions = suggestionsOpen && suggestions.length > 0;
	const { activeIndex, setActiveIndex, activeDescendantId, onKeyDown, getOptionProps } = useAutocompleteListbox({
		itemCount: suggestions.length,
		setOpen: setSuggestionsOpen,
		commitOnTab: true,
		listboxId,
		onCommit: (index) => {
			submit((showSuggestions ? suggestions[index] : void 0)?.schema);
			return true;
		}
	});
	useEffect(() => {
		resetActiveIndexRef.current = () => setActiveIndex(0);
	});
	return /* @__PURE__ */ jsxs(Fragment$1, { children: [/* @__PURE__ */ jsx(PropertyShapeButton, {
		shape: presetId,
		Glyph: preset?.Glyph,
		schemaUnknown: true,
		label: "New field",
		onClick: handleGlyphClick
	}), /* @__PURE__ */ jsxs("div", {
		className: "relative min-w-0",
		children: [/* @__PURE__ */ jsx(Input, {
			ref: (el) => {
				localInputRef.current = el;
				setNameInputEl(el);
			},
			placeholder,
			value: propertyName,
			onChange: (event) => {
				setPropertyName(event.target.value);
				setSuggestionsOpen(true);
				setActiveIndex(0);
			},
			onFocus: (event_0) => {
				propertyEditingFocus.onFocus(event_0);
				setSuggestionsOpen(true);
			},
			onBlur: () => {
				propertyEditingFocus.onBlur();
				setTimeout(() => setSuggestionsOpen(false), 100);
			},
			"aria-controls": showSuggestions ? listboxId : void 0,
			"aria-activedescendant": showSuggestions ? activeDescendantId : void 0,
			className: inputClassName ?? "h-7 min-w-0 border-transparent bg-transparent px-0 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:border-transparent focus-visible:ring-0",
			onKeyDown: (event_1) => {
				if (event_1.key === "Escape") {
					event_1.preventDefault();
					if (suggestionsOpen) {
						setSuggestionsOpen(false);
						return;
					}
					onEscape?.();
					return;
				}
				onKeyDown(event_1);
			}
		}), /* @__PURE__ */ jsx(FloatingListbox, {
			open: showSuggestions,
			anchorElement: nameInputEl,
			id: listboxId,
			role: "listbox",
			children: suggestions.map((s, i) => /* @__PURE__ */ jsxs("button", {
				type: "button",
				...getOptionProps(i),
				className: `flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted ${i === activeIndex ? "bg-muted" : ""}`,
				children: [
					/* @__PURE__ */ jsx(PropertyShapeGlyph, {
						shape: s.schema.codec.type,
						Glyph: uis.get(s.schema.name)?.Glyph ?? s.preset?.Glyph,
						className: "text-muted-foreground"
					}),
					/* @__PURE__ */ jsx("span", {
						className: "flex-1 truncate",
						children: s.schema.name
					}),
					/* @__PURE__ */ jsx("span", {
						className: "text-xs text-muted-foreground",
						children: s.preset?.label ?? propertyShapeLabel(s.schema.codec.type)
					})
				]
			}, s.schema.name))
		})]
	})] });
}
//#endregion
export { DEFAULT_PRESET_ID, FALLBACK_PRESET_ID, PropertyPicker };

//# sourceMappingURL=PropertyPicker.js.map