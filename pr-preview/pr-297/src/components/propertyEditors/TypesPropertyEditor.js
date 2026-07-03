import { Block } from "../../data/block.js";
import { cn } from "../../lib/utils.js";
import { Plus } from "../../../node_modules/lucide-react/dist/esm/icons/plus.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { FloatingListbox } from "../ui/floating-listbox.js";
import { useAutocompleteListbox } from "../../hooks/useAutocompleteListbox.js";
import { useTypes } from "../../hooks/typeRegistry.js";
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
	const $ = c(82);
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
	if ($[6] !== options) {
		t4 = new Map(options.map(_temp2));
		$[6] = options;
		$[7] = t4;
	} else t4 = $[7];
	const optionsById = t4;
	let t5;
	if ($[8] !== query) {
		t5 = query.trim().toLowerCase();
		$[8] = query;
		$[9] = t5;
	} else t5 = $[9];
	const queryText = t5;
	let t6;
	if ($[10] !== options || $[11] !== queryText || $[12] !== selectedSet) {
		t6 = options.filter((option_0) => {
			if (selectedSet.has(option_0.id)) return false;
			if (!queryText) return true;
			return option_0.id.toLowerCase().includes(queryText) || option_0.label.toLowerCase().includes(queryText);
		});
		$[10] = options;
		$[11] = queryText;
		$[12] = selectedSet;
		$[13] = t6;
	} else t6 = $[13];
	const filtered = t6;
	let t7;
	if ($[14] !== readOnly || $[15] !== typedBlock) {
		t7 = (nextTypes) => {
			if (!typedBlock || readOnly) return;
			typedBlock.repo.setBlockTypes(typedBlock.id, normalizedTypes(nextTypes));
		};
		$[14] = readOnly;
		$[15] = typedBlock;
		$[16] = t7;
	} else t7 = $[16];
	const setTypes = t7;
	let t8;
	if ($[17] !== selected || $[18] !== selectedSet || $[19] !== setTypes || $[20] !== typesRegistry) {
		t8 = (typeId) => {
			if (!typesRegistry.has(typeId) || selectedSet.has(typeId)) return;
			setTypes([...selected, typeId]);
			setQuery("");
			setOpen(false);
		};
		$[17] = selected;
		$[18] = selectedSet;
		$[19] = setTypes;
		$[20] = typesRegistry;
		$[21] = t8;
	} else t8 = $[21];
	const addType = t8;
	let t9;
	if ($[22] !== selected || $[23] !== setTypes) {
		t9 = (typeId_0) => {
			setTypes(selected.filter((selectedType) => selectedType !== typeId_0));
		};
		$[22] = selected;
		$[23] = setTypes;
		$[24] = t9;
	} else t9 = $[24];
	const removeType = t9;
	let t10;
	if ($[25] !== addType || $[26] !== filtered) {
		t10 = (index) => {
			const option_1 = filtered[index];
			if (!option_1) return false;
			addType(option_1.id);
			return true;
		};
		$[25] = addType;
		$[26] = filtered;
		$[27] = t10;
	} else t10 = $[27];
	let t11;
	if ($[28] !== filtered.length || $[29] !== listboxId || $[30] !== t10) {
		t11 = {
			itemCount: filtered.length,
			setOpen,
			listboxId,
			onCommit: t10
		};
		$[28] = filtered.length;
		$[29] = listboxId;
		$[30] = t10;
		$[31] = t11;
	} else t11 = $[31];
	const listbox = useAutocompleteListbox(t11);
	let t12;
	if ($[32] !== addType || $[33] !== filtered || $[34] !== listbox.activeIndex || $[35] !== navigated || $[36] !== options || $[37] !== queryText || $[38] !== selectedSet) {
		t12 = () => {
			const option_2 = resolveCommitTarget({
				options,
				filtered,
				queryText,
				navigated,
				activeIndex: listbox.activeIndex,
				selectedIds: selectedSet
			});
			if (!option_2) return false;
			addType(option_2.id);
			return true;
		};
		$[32] = addType;
		$[33] = filtered;
		$[34] = listbox.activeIndex;
		$[35] = navigated;
		$[36] = options;
		$[37] = queryText;
		$[38] = selectedSet;
		$[39] = t12;
	} else t12 = $[39];
	const commitCurrentQuery = t12;
	let t13;
	if ($[40] !== commitCurrentQuery || $[41] !== listbox || $[42] !== query || $[43] !== readOnly || $[44] !== removeType || $[45] !== selected) {
		t13 = (event) => {
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
		$[40] = commitCurrentQuery;
		$[41] = listbox;
		$[42] = query;
		$[43] = readOnly;
		$[44] = removeType;
		$[45] = selected;
		$[46] = t13;
	} else t13 = $[46];
	const handleInputKeyDown = t13;
	let t14;
	if ($[47] === Symbol.for("react.memo_cache_sentinel")) {
		t14 = () => {
			window.setTimeout(() => setOpen(false), 120);
		};
		$[47] = t14;
	} else t14 = $[47];
	let t15;
	if ($[48] !== optionsById || $[49] !== readOnly || $[50] !== removeType || $[51] !== selected) {
		let t16;
		if ($[53] !== optionsById || $[54] !== readOnly || $[55] !== removeType) {
			t16 = (typeId_1) => {
				const option_3 = optionsById.get(typeId_1);
				const label = option_3?.label ?? typeId_1;
				return /* @__PURE__ */ jsxs("span", {
					className: "inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-foreground",
					title: option_3?.description ?? typeId_1,
					children: [/* @__PURE__ */ jsx("span", {
						className: "truncate",
						children: label
					}), !readOnly && /* @__PURE__ */ jsx("button", {
						type: "button",
						className: "rounded-sm text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
						"aria-label": `Remove ${label} type`,
						onMouseDown: _temp3,
						onClick: () => removeType(typeId_1),
						children: /* @__PURE__ */ jsx(X, { className: "h-3 w-3" })
					})]
				}, typeId_1);
			};
			$[53] = optionsById;
			$[54] = readOnly;
			$[55] = removeType;
			$[56] = t16;
		} else t16 = $[56];
		t15 = selected.map(t16);
		$[48] = optionsById;
		$[49] = readOnly;
		$[50] = removeType;
		$[51] = selected;
		$[52] = t15;
	} else t15 = $[52];
	const t16 = open && !readOnly ? listbox.activeDescendantId : void 0;
	let t17;
	if ($[57] === Symbol.for("react.memo_cache_sentinel")) {
		t17 = () => setOpen(true);
		$[57] = t17;
	} else t17 = $[57];
	let t18;
	if ($[58] !== listbox) {
		t18 = (event_1) => {
			setQuery(event_1.target.value);
			listbox.setActiveIndex(0);
			setNavigated(false);
			setOpen(true);
		};
		$[58] = listbox;
		$[59] = t18;
	} else t18 = $[59];
	let t19;
	if ($[60] !== handleInputKeyDown || $[61] !== listboxId || $[62] !== open || $[63] !== query || $[64] !== readOnly || $[65] !== t16 || $[66] !== t18) {
		t19 = /* @__PURE__ */ jsx("input", {
			className: "h-6 min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/55 disabled:cursor-not-allowed disabled:opacity-60",
			value: query,
			placeholder: "Add type",
			disabled: readOnly,
			role: "combobox",
			"aria-label": "Add block type",
			"aria-expanded": open,
			"aria-controls": listboxId,
			"aria-autocomplete": "list",
			"aria-activedescendant": t16,
			onFocus: t17,
			onChange: t18,
			onKeyDown: handleInputKeyDown
		});
		$[60] = handleInputKeyDown;
		$[61] = listboxId;
		$[62] = open;
		$[63] = query;
		$[64] = readOnly;
		$[65] = t16;
		$[66] = t18;
		$[67] = t19;
	} else t19 = $[67];
	let t20;
	if ($[68] !== t15 || $[69] !== t19) {
		t20 = /* @__PURE__ */ jsxs("div", {
			ref: setShellElement,
			className: "flex min-h-7 min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-transparent bg-transparent px-0 py-0.5 focus-within:border-input focus-within:px-1.5",
			children: [t15, t19]
		});
		$[68] = t15;
		$[69] = t19;
		$[70] = t20;
	} else t20 = $[70];
	const t21 = open && !readOnly;
	let t22;
	if ($[71] !== filtered || $[72] !== listbox) {
		t22 = filtered.length > 0 ? filtered.map((option_4, index_0) => {
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
						children: option_4.label
					}),
					option_4.label !== option_4.id && !isOpaqueId(option_4.id) && /* @__PURE__ */ jsx("span", {
						className: "min-w-0 max-w-[12rem] truncate text-xs text-muted-foreground",
						children: option_4.id
					})
				]
			}, option_4.id);
		}) : /* @__PURE__ */ jsx("div", {
			className: "px-2 py-1.5 text-muted-foreground",
			children: "No matching types"
		});
		$[71] = filtered;
		$[72] = listbox;
		$[73] = t22;
	} else t22 = $[73];
	let t23;
	if ($[74] !== listboxId || $[75] !== shellElement || $[76] !== t21 || $[77] !== t22) {
		t23 = /* @__PURE__ */ jsx(FloatingListbox, {
			id: listboxId,
			open: t21,
			anchorElement: shellElement,
			maxWidth: 352,
			maxHeight: 224,
			children: t22
		});
		$[74] = listboxId;
		$[75] = shellElement;
		$[76] = t21;
		$[77] = t22;
		$[78] = t23;
	} else t23 = $[78];
	let t24;
	if ($[79] !== t20 || $[80] !== t23) {
		t24 = /* @__PURE__ */ jsxs("div", {
			className: "min-w-0",
			onBlur: t14,
			children: [t20, t23]
		});
		$[79] = t20;
		$[80] = t23;
		$[81] = t24;
	} else t24 = $[81];
	return t24;
}
function _temp3(event_0) {
	return event_0.preventDefault();
}
function _temp2(option) {
	return [option.id, option];
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