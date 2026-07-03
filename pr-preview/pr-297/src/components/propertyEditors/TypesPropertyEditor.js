import { Block } from "../../data/block.js";
import { cn } from "../../lib/utils.js";
import { Plus } from "../../../node_modules/lucide-react/dist/esm/icons/plus.js";
import { FloatingListbox } from "../ui/floating-listbox.js";
import { useAutocompleteListbox } from "../../hooks/useAutocompleteListbox.js";
import { useTypes } from "../../hooks/typeRegistry.js";
import { TypeChip } from "../typeChip/TypeChip.js";
import { useId, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/propertyEditors/TypesPropertyEditor.tsx
/** Which option Enter/Tab commits. Pure — exported for direct testing.
*
*  A user-defined type can share a label with an infrastructure
*  kernel/plugin type ("page", "Media"). Typing that label into a TYPE
*  picker almost always means the completion-offered one — preferring
*  it matches the `#` autocomplete's resolution (the ref-target picker
*  currently resolves such collisions by registration order — a known
*  gap, not a policy to be consistent with). A sole infrastructure
*  exact match still commits (the panel's dropdown deliberately lists
*  everything, and it's the visibly highlighted row). An explicit
*  highlight (arrows / hover → `navigated`) beats the exact-match
*  shortcut — committing something other than the highlighted row
*  contradicts what the user is looking at. */
var resolveCommitTarget = (args) => {
	const exactMatches = args.options.filter((option) => option.id.toLowerCase() === args.queryText || option.label.toLowerCase() === args.queryText);
	const exact = exactMatches.find((option) => !option.hideFromCompletion) ?? exactMatches[0];
	return !args.navigated && exact && !args.selectedIds.has(exact.id) ? exact : args.filtered[args.activeIndex] ?? args.filtered[0];
};
var normalizedTypes = (value) => Array.from(new Set(value.map((type) => type.trim()).filter(Boolean)));
/** A user-defined type's id is the type-definition block's uuid —
*  meaningless to a human picking the type. Hide it from the dropdown
*  so a long uuid can't visually drown the label even in narrow panels;
*  kernel ids ("page", "block-type", etc.) are short and human-readable
*  and stay visible as disambiguation alongside their label. */
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var isOpaqueId = (id) => UUID_PATTERN.test(id);
function TypesPropertyEditor(t0) {
	const $ = c(80);
	const { value, block } = t0;
	const listboxId = useId();
	const [shellElement, setShellElement] = useState(null);
	const typedBlock = block instanceof Block ? block : null;
	const readOnly = typedBlock?.repo.isReadOnly ?? true;
	let t1;
	if ($[0] !== value) {
		t1 = normalizedTypes(value);
		$[0] = value;
		$[1] = t1;
	} else t1 = $[1];
	const selected = t1;
	let t2;
	if ($[2] !== selected) {
		t2 = new Set(selected);
		$[2] = selected;
		$[3] = t2;
	} else t2 = $[3];
	const selectedSet = t2;
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [navigated, setNavigated] = useState(false);
	const typesRegistry = useTypes();
	let t3;
	if ($[4] !== typesRegistry) {
		t3 = Array.from(typesRegistry.values()).map(_temp);
		$[4] = typesRegistry;
		$[5] = t3;
	} else t3 = $[5];
	const options = t3;
	let t4;
	if ($[6] !== query) {
		t4 = query.trim().toLowerCase();
		$[6] = query;
		$[7] = t4;
	} else t4 = $[7];
	const queryText = t4;
	let t5;
	if ($[8] !== options || $[9] !== queryText || $[10] !== selectedSet) {
		t5 = options.filter((option) => {
			if (selectedSet.has(option.id)) return false;
			if (!queryText) return true;
			return option.id.toLowerCase().includes(queryText) || option.label.toLowerCase().includes(queryText);
		});
		$[8] = options;
		$[9] = queryText;
		$[10] = selectedSet;
		$[11] = t5;
	} else t5 = $[11];
	const filtered = t5;
	let t6;
	if ($[12] !== readOnly || $[13] !== typedBlock) {
		t6 = (nextTypes) => {
			if (!typedBlock || readOnly) return;
			typedBlock.repo.setBlockTypes(typedBlock.id, normalizedTypes(nextTypes));
		};
		$[12] = readOnly;
		$[13] = typedBlock;
		$[14] = t6;
	} else t6 = $[14];
	const setTypes = t6;
	let t7;
	if ($[15] !== selected || $[16] !== selectedSet || $[17] !== setTypes || $[18] !== typesRegistry) {
		t7 = (typeId) => {
			if (!typesRegistry.has(typeId) || selectedSet.has(typeId)) return;
			setTypes([...selected, typeId]);
			setQuery("");
			setOpen(false);
		};
		$[15] = selected;
		$[16] = selectedSet;
		$[17] = setTypes;
		$[18] = typesRegistry;
		$[19] = t7;
	} else t7 = $[19];
	const addType = t7;
	let t8;
	if ($[20] !== selected || $[21] !== setTypes) {
		t8 = (typeId_0) => {
			setTypes(selected.filter((selectedType) => selectedType !== typeId_0));
		};
		$[20] = selected;
		$[21] = setTypes;
		$[22] = t8;
	} else t8 = $[22];
	const removeType = t8;
	let t9;
	if ($[23] !== addType || $[24] !== filtered) {
		t9 = (index) => {
			const option_0 = filtered[index];
			if (!option_0) return false;
			addType(option_0.id);
			return true;
		};
		$[23] = addType;
		$[24] = filtered;
		$[25] = t9;
	} else t9 = $[25];
	let t10;
	if ($[26] !== filtered.length || $[27] !== listboxId || $[28] !== t9) {
		t10 = {
			itemCount: filtered.length,
			setOpen,
			listboxId,
			onCommit: t9
		};
		$[26] = filtered.length;
		$[27] = listboxId;
		$[28] = t9;
		$[29] = t10;
	} else t10 = $[29];
	const listbox = useAutocompleteListbox(t10);
	let t11;
	if ($[30] !== addType || $[31] !== filtered || $[32] !== listbox.activeIndex || $[33] !== navigated || $[34] !== options || $[35] !== queryText || $[36] !== selectedSet) {
		t11 = () => {
			const option_1 = resolveCommitTarget({
				options,
				filtered,
				queryText,
				navigated,
				activeIndex: listbox.activeIndex,
				selectedIds: selectedSet
			});
			if (!option_1) return false;
			addType(option_1.id);
			return true;
		};
		$[30] = addType;
		$[31] = filtered;
		$[32] = listbox.activeIndex;
		$[33] = navigated;
		$[34] = options;
		$[35] = queryText;
		$[36] = selectedSet;
		$[37] = t11;
	} else t11 = $[37];
	const commitCurrentQuery = t11;
	let t12;
	if ($[38] !== commitCurrentQuery || $[39] !== listbox || $[40] !== query || $[41] !== readOnly || $[42] !== removeType || $[43] !== selected) {
		t12 = (event) => {
			if (readOnly) return;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				setNavigated(true);
				listbox.onKeyDown(event);
				return;
			}
			if ((event.key === "Enter" || event.key === "Tab") && query.trim()) {
				if (commitCurrentQuery()) event.preventDefault();
				return;
			}
			if (event.key === "Backspace" && !query && selected.length > 0) {
				event.preventDefault();
				removeType(selected[selected.length - 1]);
				return;
			}
			if (event.key === "Escape") setOpen(false);
		};
		$[38] = commitCurrentQuery;
		$[39] = listbox;
		$[40] = query;
		$[41] = readOnly;
		$[42] = removeType;
		$[43] = selected;
		$[44] = t12;
	} else t12 = $[44];
	const handleInputKeyDown = t12;
	let t13;
	if ($[45] === Symbol.for("react.memo_cache_sentinel")) {
		t13 = () => {
			window.setTimeout(() => setOpen(false), 120);
		};
		$[45] = t13;
	} else t13 = $[45];
	let t14;
	if ($[46] !== readOnly || $[47] !== removeType || $[48] !== selected || $[49] !== typesRegistry) {
		let t15;
		if ($[51] !== readOnly || $[52] !== removeType || $[53] !== typesRegistry) {
			t15 = (typeId_1) => /* @__PURE__ */ jsx(TypeChip, {
				typeId: typeId_1,
				type: typesRegistry.get(typeId_1),
				onRemove: readOnly ? void 0 : () => removeType(typeId_1)
			}, typeId_1);
			$[51] = readOnly;
			$[52] = removeType;
			$[53] = typesRegistry;
			$[54] = t15;
		} else t15 = $[54];
		t14 = selected.map(t15);
		$[46] = readOnly;
		$[47] = removeType;
		$[48] = selected;
		$[49] = typesRegistry;
		$[50] = t14;
	} else t14 = $[50];
	const t15 = open && !readOnly ? listbox.activeDescendantId : void 0;
	let t16;
	if ($[55] === Symbol.for("react.memo_cache_sentinel")) {
		t16 = () => setOpen(true);
		$[55] = t16;
	} else t16 = $[55];
	let t17;
	if ($[56] !== listbox) {
		t17 = (event_0) => {
			setQuery(event_0.target.value);
			listbox.setActiveIndex(0);
			setNavigated(false);
			setOpen(true);
		};
		$[56] = listbox;
		$[57] = t17;
	} else t17 = $[57];
	let t18;
	if ($[58] !== handleInputKeyDown || $[59] !== listboxId || $[60] !== open || $[61] !== query || $[62] !== readOnly || $[63] !== t15 || $[64] !== t17) {
		t18 = /* @__PURE__ */ jsx("input", {
			className: "h-6 min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/55 disabled:cursor-not-allowed disabled:opacity-60",
			value: query,
			placeholder: "Add type",
			disabled: readOnly,
			role: "combobox",
			"aria-label": "Add block type",
			"aria-expanded": open,
			"aria-controls": listboxId,
			"aria-autocomplete": "list",
			"aria-activedescendant": t15,
			onFocus: t16,
			onChange: t17,
			onKeyDown: handleInputKeyDown
		});
		$[58] = handleInputKeyDown;
		$[59] = listboxId;
		$[60] = open;
		$[61] = query;
		$[62] = readOnly;
		$[63] = t15;
		$[64] = t17;
		$[65] = t18;
	} else t18 = $[65];
	let t19;
	if ($[66] !== t14 || $[67] !== t18) {
		t19 = /* @__PURE__ */ jsxs("div", {
			ref: setShellElement,
			className: "flex min-h-7 min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-transparent bg-transparent px-0 py-0.5 focus-within:border-input focus-within:px-1.5",
			children: [t14, t18]
		});
		$[66] = t14;
		$[67] = t18;
		$[68] = t19;
	} else t19 = $[68];
	const t20 = open && !readOnly;
	let t21;
	if ($[69] !== filtered || $[70] !== listbox) {
		t21 = filtered.length > 0 ? filtered.map((option_2, index_0) => {
			const optionProps = listbox.getOptionProps(index_0);
			return /* @__PURE__ */ jsxs("button", {
				type: "button",
				...optionProps,
				className: cn("flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left", index_0 === listbox.activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent hover:text-accent-foreground"),
				onMouseEnter: () => {
					setNavigated(true);
					optionProps.onMouseEnter();
				},
				children: [
					/* @__PURE__ */ jsx(Plus, { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" }),
					/* @__PURE__ */ jsx("span", {
						className: "min-w-0 flex-1 truncate",
						children: option_2.label
					}),
					option_2.label !== option_2.id && !isOpaqueId(option_2.id) && /* @__PURE__ */ jsx("span", {
						className: "min-w-0 max-w-[12rem] truncate text-xs text-muted-foreground",
						children: option_2.id
					})
				]
			}, option_2.id);
		}) : /* @__PURE__ */ jsx("div", {
			className: "px-2 py-1.5 text-muted-foreground",
			children: "No matching types"
		});
		$[69] = filtered;
		$[70] = listbox;
		$[71] = t21;
	} else t21 = $[71];
	let t22;
	if ($[72] !== listboxId || $[73] !== shellElement || $[74] !== t20 || $[75] !== t21) {
		t22 = /* @__PURE__ */ jsx(FloatingListbox, {
			id: listboxId,
			open: t20,
			anchorElement: shellElement,
			maxWidth: 352,
			maxHeight: 224,
			children: t21
		});
		$[72] = listboxId;
		$[73] = shellElement;
		$[74] = t20;
		$[75] = t21;
		$[76] = t22;
	} else t22 = $[76];
	let t23;
	if ($[77] !== t19 || $[78] !== t22) {
		t23 = /* @__PURE__ */ jsxs("div", {
			className: "min-w-0",
			onBlur: t13,
			children: [t19, t22]
		});
		$[77] = t19;
		$[78] = t22;
		$[79] = t23;
	} else t23 = $[79];
	return t23;
}
function _temp(type) {
	return {
		id: type.id,
		label: type.label ?? type.id,
		description: type.description,
		hideFromCompletion: type.hideFromCompletion === true
	};
}
//#endregion
export { TypesPropertyEditor, resolveCommitTarget };

//# sourceMappingURL=TypesPropertyEditor.js.map