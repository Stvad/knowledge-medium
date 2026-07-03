import { typesFacet } from "../../data/facets.js";
import { Block } from "../../data/block.js";
import { cn } from "../../lib/utils.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { Plus } from "../../../node_modules/lucide-react/dist/esm/icons/plus.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { FloatingListbox } from "../ui/floating-listbox.js";
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
	const $ = c(75);
	const { value, block } = t0;
	const runtime = useAppRuntime();
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
	const [activeIndex, setActiveIndex] = useState(0);
	const [navigated, setNavigated] = useState(false);
	let t3;
	if ($[4] !== runtime) {
		t3 = runtime.read(typesFacet);
		$[4] = runtime;
		$[5] = t3;
	} else t3 = $[5];
	const typesRegistry = t3;
	let t4;
	if ($[6] !== typesRegistry) {
		t4 = Array.from(typesRegistry.values()).map(_temp);
		$[6] = typesRegistry;
		$[7] = t4;
	} else t4 = $[7];
	const options = t4;
	let t5;
	if ($[8] !== options) {
		t5 = new Map(options.map(_temp2));
		$[8] = options;
		$[9] = t5;
	} else t5 = $[9];
	const optionsById = t5;
	let t6;
	if ($[10] !== query) {
		t6 = query.trim().toLowerCase();
		$[10] = query;
		$[11] = t6;
	} else t6 = $[11];
	const queryText = t6;
	let t7;
	if ($[12] !== options || $[13] !== queryText || $[14] !== selectedSet) {
		t7 = options.filter((option_0) => {
			if (selectedSet.has(option_0.id)) return false;
			if (!queryText) return true;
			return option_0.id.toLowerCase().includes(queryText) || option_0.label.toLowerCase().includes(queryText);
		});
		$[12] = options;
		$[13] = queryText;
		$[14] = selectedSet;
		$[15] = t7;
	} else t7 = $[15];
	const filtered = t7;
	let t8;
	if ($[16] !== readOnly || $[17] !== typedBlock) {
		t8 = (nextTypes) => {
			if (!typedBlock || readOnly) return;
			typedBlock.repo.setBlockTypes(typedBlock.id, normalizedTypes(nextTypes));
		};
		$[16] = readOnly;
		$[17] = typedBlock;
		$[18] = t8;
	} else t8 = $[18];
	const setTypes = t8;
	let t9;
	if ($[19] !== selected || $[20] !== selectedSet || $[21] !== setTypes || $[22] !== typesRegistry) {
		t9 = (typeId) => {
			if (!typesRegistry.has(typeId) || selectedSet.has(typeId)) return;
			setTypes([...selected, typeId]);
			setQuery("");
			setOpen(false);
		};
		$[19] = selected;
		$[20] = selectedSet;
		$[21] = setTypes;
		$[22] = typesRegistry;
		$[23] = t9;
	} else t9 = $[23];
	const addType = t9;
	let t10;
	if ($[24] !== selected || $[25] !== setTypes) {
		t10 = (typeId_0) => {
			setTypes(selected.filter((selectedType) => selectedType !== typeId_0));
		};
		$[24] = selected;
		$[25] = setTypes;
		$[26] = t10;
	} else t10 = $[26];
	const removeType = t10;
	let t11;
	if ($[27] !== activeIndex || $[28] !== addType || $[29] !== filtered || $[30] !== navigated || $[31] !== options || $[32] !== queryText || $[33] !== selectedSet) {
		t11 = () => {
			const option_1 = resolveCommitTarget({
				options,
				filtered,
				queryText,
				navigated,
				activeIndex,
				selectedIds: selectedSet
			});
			if (!option_1) return false;
			addType(option_1.id);
			return true;
		};
		$[27] = activeIndex;
		$[28] = addType;
		$[29] = filtered;
		$[30] = navigated;
		$[31] = options;
		$[32] = queryText;
		$[33] = selectedSet;
		$[34] = t11;
	} else t11 = $[34];
	const commitCurrentQuery = t11;
	let t12;
	if ($[35] !== commitCurrentQuery || $[36] !== filtered.length || $[37] !== query || $[38] !== readOnly || $[39] !== removeType || $[40] !== selected) {
		t12 = (event) => {
			if (readOnly) return;
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setOpen(true);
				setNavigated(true);
				setActiveIndex((index) => Math.min(index + 1, Math.max(filtered.length - 1, 0)));
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setNavigated(true);
				setActiveIndex(_temp3);
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
		$[35] = commitCurrentQuery;
		$[36] = filtered.length;
		$[37] = query;
		$[38] = readOnly;
		$[39] = removeType;
		$[40] = selected;
		$[41] = t12;
	} else t12 = $[41];
	const handleInputKeyDown = t12;
	let t13;
	if ($[42] === Symbol.for("react.memo_cache_sentinel")) {
		t13 = () => {
			window.setTimeout(() => setOpen(false), 120);
		};
		$[42] = t13;
	} else t13 = $[42];
	let t14;
	if ($[43] !== optionsById || $[44] !== readOnly || $[45] !== removeType || $[46] !== selected) {
		let t15;
		if ($[48] !== optionsById || $[49] !== readOnly || $[50] !== removeType) {
			t15 = (typeId_1) => {
				const option_2 = optionsById.get(typeId_1);
				const label = option_2?.label ?? typeId_1;
				return /* @__PURE__ */ jsxs("span", {
					className: "inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-foreground",
					title: option_2?.description ?? typeId_1,
					children: [/* @__PURE__ */ jsx("span", {
						className: "truncate",
						children: label
					}), !readOnly && /* @__PURE__ */ jsx("button", {
						type: "button",
						className: "rounded-sm text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
						"aria-label": `Remove ${label} type`,
						onMouseDown: _temp4,
						onClick: () => removeType(typeId_1),
						children: /* @__PURE__ */ jsx(X, { className: "h-3 w-3" })
					})]
				}, typeId_1);
			};
			$[48] = optionsById;
			$[49] = readOnly;
			$[50] = removeType;
			$[51] = t15;
		} else t15 = $[51];
		t14 = selected.map(t15);
		$[43] = optionsById;
		$[44] = readOnly;
		$[45] = removeType;
		$[46] = selected;
		$[47] = t14;
	} else t14 = $[47];
	let t15;
	let t16;
	if ($[52] === Symbol.for("react.memo_cache_sentinel")) {
		t15 = () => setOpen(true);
		t16 = (event_1) => {
			setQuery(event_1.target.value);
			setActiveIndex(0);
			setNavigated(false);
			setOpen(true);
		};
		$[52] = t15;
		$[53] = t16;
	} else {
		t15 = $[52];
		t16 = $[53];
	}
	let t17;
	if ($[54] !== handleInputKeyDown || $[55] !== listboxId || $[56] !== open || $[57] !== query || $[58] !== readOnly) {
		t17 = /* @__PURE__ */ jsx("input", {
			className: "h-6 min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/55 disabled:cursor-not-allowed disabled:opacity-60",
			value: query,
			placeholder: "Add type",
			disabled: readOnly,
			role: "combobox",
			"aria-label": "Add block type",
			"aria-expanded": open,
			"aria-controls": listboxId,
			"aria-autocomplete": "list",
			onFocus: t15,
			onChange: t16,
			onKeyDown: handleInputKeyDown
		});
		$[54] = handleInputKeyDown;
		$[55] = listboxId;
		$[56] = open;
		$[57] = query;
		$[58] = readOnly;
		$[59] = t17;
	} else t17 = $[59];
	let t18;
	if ($[60] !== t14 || $[61] !== t17) {
		t18 = /* @__PURE__ */ jsxs("div", {
			ref: setShellElement,
			className: "flex min-h-7 min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-transparent bg-transparent px-0 py-0.5 focus-within:border-input focus-within:px-1.5",
			children: [t14, t17]
		});
		$[60] = t14;
		$[61] = t17;
		$[62] = t18;
	} else t18 = $[62];
	const t19 = open && !readOnly;
	let t20;
	if ($[63] !== activeIndex || $[64] !== addType || $[65] !== filtered) {
		t20 = filtered.length > 0 ? filtered.map((option_3, index_1) => /* @__PURE__ */ jsxs("button", {
			type: "button",
			role: "option",
			"aria-selected": index_1 === activeIndex,
			className: cn("flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left", index_1 === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent hover:text-accent-foreground"),
			onMouseDown: _temp5,
			onMouseEnter: () => {
				setNavigated(true);
				setActiveIndex(index_1);
			},
			onClick: () => addType(option_3.id),
			children: [
				/* @__PURE__ */ jsx(Plus, { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" }),
				/* @__PURE__ */ jsx("span", {
					className: "min-w-0 flex-1 truncate",
					children: option_3.label
				}),
				option_3.label !== option_3.id && !isOpaqueId(option_3.id) && /* @__PURE__ */ jsx("span", {
					className: "min-w-0 max-w-[12rem] truncate text-xs text-muted-foreground",
					children: option_3.id
				})
			]
		}, option_3.id)) : /* @__PURE__ */ jsx("div", {
			className: "px-2 py-1.5 text-muted-foreground",
			children: "No matching types"
		});
		$[63] = activeIndex;
		$[64] = addType;
		$[65] = filtered;
		$[66] = t20;
	} else t20 = $[66];
	let t21;
	if ($[67] !== listboxId || $[68] !== shellElement || $[69] !== t19 || $[70] !== t20) {
		t21 = /* @__PURE__ */ jsx(FloatingListbox, {
			id: listboxId,
			open: t19,
			anchorElement: shellElement,
			maxWidth: 352,
			maxHeight: 224,
			children: t20
		});
		$[67] = listboxId;
		$[68] = shellElement;
		$[69] = t19;
		$[70] = t20;
		$[71] = t21;
	} else t21 = $[71];
	let t22;
	if ($[72] !== t18 || $[73] !== t21) {
		t22 = /* @__PURE__ */ jsxs("div", {
			className: "min-w-0",
			onBlur: t13,
			children: [t18, t21]
		});
		$[72] = t18;
		$[73] = t21;
		$[74] = t22;
	} else t22 = $[74];
	return t22;
}
function _temp5(event_2) {
	return event_2.preventDefault();
}
function _temp4(event_0) {
	return event_0.preventDefault();
}
function _temp3(index_0) {
	return Math.max(index_0 - 1, 0);
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