import { isReadOnlyBlock } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { cn } from "../../lib/utils.js";
import { Input } from "../../components/ui/input.js";
import { Button } from "../../components/ui/button.js";
import { truncate } from "../../utils/string.js";
import { uniqueStrings } from "../../utils/array.js";
import { normalizeGroupedBacklinksConfig } from "./config.js";
import { searchLinkTargetValueCandidates } from "../../utils/linkTargetAutocomplete.js";
import { useRepo } from "../../context/repo.js";
import { Plus } from "../../../node_modules/lucide-react/dist/esm/icons/plus.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { FloatingListbox } from "../../components/ui/floating-listbox.js";
import { useAutocompleteListbox } from "../../hooks/useAutocompleteListbox.js";
import { useDebouncedSearch } from "../../hooks/useDebouncedSearch.js";
import { useId, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.tsx
var SEARCH_LIMIT = 6;
var DEBOUNCE_MS = 80;
var toneClass = (tone) => {
	switch (tone) {
		case "high": return "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200";
		case "low": return "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200";
		case "excluded": return "border-rose-500/30 bg-rose-500/10 text-rose-900 dark:text-rose-200";
	}
};
var TagChip = (t0) => {
	const $ = c(13);
	const { value, tone, readOnly, onRemove } = t0;
	let t1;
	if ($[0] !== tone) {
		t1 = cn("inline-flex min-w-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs", toneClass(tone));
		$[0] = tone;
		$[1] = t1;
	} else t1 = $[1];
	let t2;
	if ($[2] !== value) {
		t2 = /* @__PURE__ */ jsx("span", {
			className: "max-w-[18ch] truncate",
			children: value
		});
		$[2] = value;
		$[3] = t2;
	} else t2 = $[3];
	let t3;
	if ($[4] !== onRemove || $[5] !== readOnly || $[6] !== value) {
		t3 = !readOnly && /* @__PURE__ */ jsx("button", {
			type: "button",
			onClick: onRemove,
			className: "shrink-0 rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
			"aria-label": `Remove ${value}`,
			children: /* @__PURE__ */ jsx(X, { className: "h-3 w-3" })
		});
		$[4] = onRemove;
		$[5] = readOnly;
		$[6] = value;
		$[7] = t3;
	} else t3 = $[7];
	let t4;
	if ($[8] !== t1 || $[9] !== t2 || $[10] !== t3 || $[11] !== value) {
		t4 = /* @__PURE__ */ jsxs("span", {
			className: t1,
			title: value,
			children: [t2, t3]
		});
		$[8] = t1;
		$[9] = t2;
		$[10] = t3;
		$[11] = value;
		$[12] = t4;
	} else t4 = $[12];
	return t4;
};
var ConfigTagInput = (t0) => {
	const $ = c(64);
	const { label, placeholder, tone, values, readOnly, onChange } = t0;
	const repo = useRepo();
	const listboxId = useId();
	const [formElement, setFormElement] = useState(null);
	const workspaceId = repo.activeWorkspaceId ?? "";
	const [query, setQuery] = useState("");
	const [focused, setFocused] = useState(false);
	let t1;
	if ($[0] !== values) {
		t1 = uniqueStrings(values);
		$[0] = values;
		$[1] = t1;
	} else t1 = $[1];
	const currentValues = t1;
	let t2;
	if ($[2] !== currentValues) {
		t2 = new Set(currentValues);
		$[2] = currentValues;
		$[3] = t2;
	} else t2 = $[3];
	const currentValueSet = t2;
	let t3;
	if ($[4] !== query) {
		t3 = query.trim();
		$[4] = query;
		$[5] = t3;
	} else t3 = $[5];
	const trimmed = t3;
	let t4;
	if ($[6] !== currentValueSet || $[7] !== repo || $[8] !== workspaceId) {
		t4 = (q) => searchLinkTargetValueCandidates(repo, {
			workspaceId,
			query: q,
			limit: SEARCH_LIMIT,
			excludeValues: currentValueSet
		});
		$[6] = currentValueSet;
		$[7] = repo;
		$[8] = workspaceId;
		$[9] = t4;
	} else t4 = $[9];
	let t5;
	if ($[10] !== currentValueSet || $[11] !== workspaceId) {
		t5 = [workspaceId, currentValueSet];
		$[10] = currentValueSet;
		$[11] = workspaceId;
		$[12] = t5;
	} else t5 = $[12];
	const { results, resultsQuery, reset: resetResults } = useDebouncedSearch({
		query,
		delayMs: DEBOUNCE_MS,
		enabled: Boolean(workspaceId),
		search: t4,
		onResults: () => setActiveIndex(0),
		revalidateOn: t5
	});
	const popupOpen = focused && trimmed.length > 0 && results.length > 0;
	let t6;
	if ($[13] !== currentValues || $[14] !== onChange || $[15] !== readOnly || $[16] !== resetResults) {
		t6 = (value) => {
			if (readOnly) return;
			const next = value.trim();
			if (!next) return;
			onChange(uniqueStrings([...currentValues, next]));
			setQuery("");
			resetResults();
		};
		$[13] = currentValues;
		$[14] = onChange;
		$[15] = readOnly;
		$[16] = resetResults;
		$[17] = t6;
	} else t6 = $[17];
	const commitValue = t6;
	let t7;
	if ($[18] !== commitValue || $[19] !== results) {
		t7 = (index) => {
			const candidate = results[index];
			if (!candidate) return false;
			commitValue(candidate.value);
			return true;
		};
		$[18] = commitValue;
		$[19] = results;
		$[20] = t7;
	} else t7 = $[20];
	let t8;
	if ($[21] !== listboxId || $[22] !== results.length || $[23] !== t7) {
		t8 = {
			itemCount: results.length,
			setOpen: setFocused,
			wrap: true,
			listboxId,
			onCommit: t7
		};
		$[21] = listboxId;
		$[22] = results.length;
		$[23] = t7;
		$[24] = t8;
	} else t8 = $[24];
	const { activeIndex, setActiveIndex: t9, activeDescendantId, onKeyDown, getOptionProps } = useAutocompleteListbox(t8);
	const setActiveIndex = t9;
	let t10;
	if ($[25] !== currentValues || $[26] !== onChange || $[27] !== readOnly) {
		t10 = (value_0) => {
			if (readOnly) return;
			onChange(currentValues.filter((existing) => existing !== value_0));
		};
		$[25] = currentValues;
		$[26] = onChange;
		$[27] = readOnly;
		$[28] = t10;
	} else t10 = $[28];
	const remove = t10;
	let t11;
	if ($[29] !== activeIndex || $[30] !== commitValue || $[31] !== results || $[32] !== resultsQuery || $[33] !== trimmed) {
		t11 = (event) => {
			event.preventDefault();
			commitValue((resultsQuery === trimmed ? results[activeIndex]?.value : void 0) ?? trimmed);
		};
		$[29] = activeIndex;
		$[30] = commitValue;
		$[31] = results;
		$[32] = resultsQuery;
		$[33] = trimmed;
		$[34] = t11;
	} else t11 = $[34];
	const handleSubmit = t11;
	let t12;
	if ($[35] !== label) {
		t12 = /* @__PURE__ */ jsx("label", {
			className: "text-xs font-medium text-muted-foreground",
			children: label
		});
		$[35] = label;
		$[36] = t12;
	} else t12 = $[36];
	let t13;
	if ($[37] !== currentValues || $[38] !== readOnly || $[39] !== remove || $[40] !== tone) {
		t13 = currentValues.length > 0 && /* @__PURE__ */ jsx("div", {
			className: "flex min-w-0 flex-wrap gap-1",
			children: currentValues.map((value_1) => /* @__PURE__ */ jsx(TagChip, {
				value: value_1,
				tone,
				readOnly,
				onRemove: () => remove(value_1)
			}, value_1))
		});
		$[37] = currentValues;
		$[38] = readOnly;
		$[39] = remove;
		$[40] = tone;
		$[41] = t13;
	} else t13 = $[41];
	let t14;
	if ($[42] !== activeDescendantId || $[43] !== activeIndex || $[44] !== commitValue || $[45] !== formElement || $[46] !== getOptionProps || $[47] !== handleSubmit || $[48] !== label || $[49] !== listboxId || $[50] !== onKeyDown || $[51] !== placeholder || $[52] !== popupOpen || $[53] !== query || $[54] !== readOnly || $[55] !== resetResults || $[56] !== results || $[57] !== resultsQuery || $[58] !== trimmed) {
		t14 = !readOnly && /* @__PURE__ */ jsxs("form", {
			ref: setFormElement,
			className: "flex min-w-0 flex-1 gap-1",
			onSubmit: handleSubmit,
			children: [
				/* @__PURE__ */ jsx(Input, {
					value: query,
					onChange: (event_0) => {
						const next_0 = event_0.target.value;
						setQuery(next_0);
						if (!next_0.trim()) resetResults();
					},
					onFocus: () => setFocused(true),
					onBlur: () => setFocused(false),
					onKeyDown: (event_1) => {
						if (event_1.key === "Escape") {
							setQuery("");
							resetResults();
							return;
						}
						if (event_1.key === "Enter" && resultsQuery !== trimmed) {
							event_1.preventDefault();
							commitValue(trimmed);
							return;
						}
						onKeyDown(event_1);
					},
					placeholder,
					className: "h-8 min-w-0 text-xs",
					role: "combobox",
					"aria-autocomplete": "list",
					"aria-expanded": Boolean(popupOpen),
					"aria-controls": popupOpen ? listboxId : void 0,
					"aria-activedescendant": popupOpen ? activeDescendantId : void 0
				}),
				/* @__PURE__ */ jsx(Button, {
					type: "submit",
					variant: "ghost",
					size: "icon",
					className: "h-8 w-8 shrink-0",
					disabled: !trimmed,
					title: `Add ${label.toLowerCase()}`,
					"aria-label": `Add ${label.toLowerCase()}`,
					children: /* @__PURE__ */ jsx(Plus, { className: "h-4 w-4" })
				}),
				/* @__PURE__ */ jsx(FloatingListbox, {
					id: listboxId,
					open: popupOpen,
					anchorElement: formElement,
					maxWidth: 384,
					maxHeight: 224,
					className: "text-xs shadow-md",
					children: results.map((result, index_0) => /* @__PURE__ */ jsxs("button", {
						type: "button",
						...getOptionProps(index_0),
						className: cn("flex w-full min-w-0 flex-col rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", index_0 === activeIndex ? "bg-accent" : ""),
						children: [/* @__PURE__ */ jsx("span", {
							className: "truncate font-medium",
							children: result.label
						}), result.detail && result.detail !== result.label && /* @__PURE__ */ jsx("span", {
							className: "truncate text-muted-foreground",
							children: truncate(result.detail, 72)
						})]
					}, result.key))
				})
			]
		});
		$[42] = activeDescendantId;
		$[43] = activeIndex;
		$[44] = commitValue;
		$[45] = formElement;
		$[46] = getOptionProps;
		$[47] = handleSubmit;
		$[48] = label;
		$[49] = listboxId;
		$[50] = onKeyDown;
		$[51] = placeholder;
		$[52] = popupOpen;
		$[53] = query;
		$[54] = readOnly;
		$[55] = resetResults;
		$[56] = results;
		$[57] = resultsQuery;
		$[58] = trimmed;
		$[59] = t14;
	} else t14 = $[59];
	let t15;
	if ($[60] !== t12 || $[61] !== t13 || $[62] !== t14) {
		t15 = /* @__PURE__ */ jsxs("div", {
			className: "space-y-1.5",
			children: [
				t12,
				t13,
				t14
			]
		});
		$[60] = t12;
		$[61] = t13;
		$[62] = t14;
		$[63] = t15;
	} else t15 = $[63];
	return t15;
};
var regexError = (pattern) => {
	if (!pattern.trim()) return null;
	try {
		new RegExp(pattern);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : "Invalid regex";
	}
};
var PatternListInput = (t0) => {
	const $ = c(35);
	const { label, values, readOnly, onChange } = t0;
	const [newPattern, setNewPattern] = useState("");
	let t1;
	if ($[0] !== values) {
		t1 = uniqueStrings(values);
		$[0] = values;
		$[1] = t1;
	} else t1 = $[1];
	const patterns = t1;
	let t2;
	if ($[2] !== newPattern || $[3] !== onChange || $[4] !== patterns || $[5] !== readOnly) {
		t2 = () => {
			if (readOnly) return;
			const pattern = newPattern.trim();
			if (!pattern) return;
			onChange(uniqueStrings([...patterns, pattern]));
			setNewPattern("");
		};
		$[2] = newPattern;
		$[3] = onChange;
		$[4] = patterns;
		$[5] = readOnly;
		$[6] = t2;
	} else t2 = $[6];
	const addPattern = t2;
	let t3;
	if ($[7] !== onChange || $[8] !== patterns || $[9] !== readOnly) {
		t3 = (index, next) => {
			if (readOnly) return;
			onChange(patterns.map((pattern_0, patternIndex) => patternIndex === index ? next : pattern_0));
		};
		$[7] = onChange;
		$[8] = patterns;
		$[9] = readOnly;
		$[10] = t3;
	} else t3 = $[10];
	const updatePattern = t3;
	let t4;
	if ($[11] !== onChange || $[12] !== patterns || $[13] !== readOnly) {
		t4 = (index_0) => {
			if (readOnly) return;
			onChange(patterns.filter((_, patternIndex_0) => patternIndex_0 !== index_0));
		};
		$[11] = onChange;
		$[12] = patterns;
		$[13] = readOnly;
		$[14] = t4;
	} else t4 = $[14];
	const removePattern = t4;
	let t5;
	if ($[15] !== label) {
		t5 = /* @__PURE__ */ jsx("label", {
			className: "text-xs font-medium text-muted-foreground",
			children: label
		});
		$[15] = label;
		$[16] = t5;
	} else t5 = $[16];
	let t6;
	if ($[17] !== patterns || $[18] !== readOnly || $[19] !== removePattern || $[20] !== updatePattern) {
		let t7;
		if ($[22] !== readOnly || $[23] !== removePattern || $[24] !== updatePattern) {
			t7 = (pattern_1, index_1) => {
				const error = regexError(pattern_1);
				return /* @__PURE__ */ jsxs("div", {
					className: "space-y-1",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "flex min-w-0 gap-1",
						children: [/* @__PURE__ */ jsx(Input, {
							value: pattern_1,
							onChange: (event) => updatePattern(index_1, event.target.value),
							className: cn("h-8 min-w-0 font-mono text-xs", error ? "border-destructive focus-visible:ring-destructive" : ""),
							"aria-invalid": Boolean(error),
							title: error ?? pattern_1,
							disabled: readOnly
						}), !readOnly && /* @__PURE__ */ jsx(Button, {
							type: "button",
							variant: "ghost",
							size: "icon",
							className: "h-8 w-8 shrink-0 text-destructive hover:text-destructive",
							onClick: () => removePattern(index_1),
							"aria-label": `Remove ${pattern_1}`,
							children: /* @__PURE__ */ jsx(X, { className: "h-4 w-4" })
						})]
					}), error && /* @__PURE__ */ jsx("div", {
						className: "text-xs text-destructive",
						children: truncate(error, 96)
					})]
				}, index_1);
			};
			$[22] = readOnly;
			$[23] = removePattern;
			$[24] = updatePattern;
			$[25] = t7;
		} else t7 = $[25];
		t6 = patterns.map(t7);
		$[17] = patterns;
		$[18] = readOnly;
		$[19] = removePattern;
		$[20] = updatePattern;
		$[21] = t6;
	} else t6 = $[21];
	let t7;
	if ($[26] !== addPattern || $[27] !== label || $[28] !== newPattern || $[29] !== readOnly) {
		t7 = !readOnly && /* @__PURE__ */ jsxs("div", {
			className: "flex min-w-0 gap-1",
			children: [/* @__PURE__ */ jsx(Input, {
				value: newPattern,
				onChange: (event_0) => setNewPattern(event_0.target.value),
				onKeyDown: (event_1) => {
					if (event_1.key === "Enter") {
						event_1.preventDefault();
						addPattern();
					}
				},
				placeholder: "Add pattern",
				className: "h-8 min-w-0 font-mono text-xs"
			}), /* @__PURE__ */ jsx(Button, {
				type: "button",
				variant: "ghost",
				size: "icon",
				className: "h-8 w-8 shrink-0",
				onClick: addPattern,
				disabled: !newPattern.trim(),
				"aria-label": `Add ${label.toLowerCase()}`,
				title: `Add ${label.toLowerCase()}`,
				children: /* @__PURE__ */ jsx(Plus, { className: "h-4 w-4" })
			})]
		});
		$[26] = addPattern;
		$[27] = label;
		$[28] = newPattern;
		$[29] = readOnly;
		$[30] = t7;
	} else t7 = $[30];
	let t8;
	if ($[31] !== t5 || $[32] !== t6 || $[33] !== t7) {
		t8 = /* @__PURE__ */ jsxs("div", {
			className: "space-y-1.5",
			children: [
				t5,
				t6,
				t7
			]
		});
		$[31] = t5;
		$[32] = t6;
		$[33] = t7;
		$[34] = t8;
	} else t8 = $[34];
	return t8;
};
var GroupedBacklinksDefaultsEditor = (t0) => {
	const $ = c(37);
	const { value, onChange, block } = t0;
	let t1;
	if ($[0] !== block) {
		t1 = isReadOnlyBlock(block);
		$[0] = block;
		$[1] = t1;
	} else t1 = $[1];
	const readOnly = t1;
	let t2;
	if ($[2] !== value) {
		t2 = normalizeGroupedBacklinksConfig(value);
		$[2] = value;
		$[3] = t2;
	} else t2 = $[3];
	const config = t2;
	let t3;
	if ($[4] !== config || $[5] !== onChange || $[6] !== readOnly) {
		t3 = (key, next) => {
			if (readOnly) return;
			onChange({
				...config,
				[key]: uniqueStrings(next)
			});
		};
		$[4] = config;
		$[5] = onChange;
		$[6] = readOnly;
		$[7] = t3;
	} else t3 = $[7];
	const update = t3;
	let t4;
	if ($[8] !== update) {
		t4 = (next_0) => update("highPriorityTags", next_0);
		$[8] = update;
		$[9] = t4;
	} else t4 = $[9];
	let t5;
	if ($[10] !== config.highPriorityTags || $[11] !== readOnly || $[12] !== t4) {
		t5 = /* @__PURE__ */ jsx(ConfigTagInput, {
			label: "High priority",
			placeholder: "Add tag",
			tone: "high",
			values: config.highPriorityTags,
			readOnly,
			onChange: t4
		});
		$[10] = config.highPriorityTags;
		$[11] = readOnly;
		$[12] = t4;
		$[13] = t5;
	} else t5 = $[13];
	let t6;
	if ($[14] !== update) {
		t6 = (next_1) => update("lowPriorityTags", next_1);
		$[14] = update;
		$[15] = t6;
	} else t6 = $[15];
	let t7;
	if ($[16] !== config.lowPriorityTags || $[17] !== readOnly || $[18] !== t6) {
		t7 = /* @__PURE__ */ jsx(ConfigTagInput, {
			label: "Low priority",
			placeholder: "Add tag",
			tone: "low",
			values: config.lowPriorityTags,
			readOnly,
			onChange: t6
		});
		$[16] = config.lowPriorityTags;
		$[17] = readOnly;
		$[18] = t6;
		$[19] = t7;
	} else t7 = $[19];
	let t8;
	if ($[20] !== update) {
		t8 = (next_2) => update("excludedTags", next_2);
		$[20] = update;
		$[21] = t8;
	} else t8 = $[21];
	let t9;
	if ($[22] !== config.excludedTags || $[23] !== readOnly || $[24] !== t8) {
		t9 = /* @__PURE__ */ jsx(ConfigTagInput, {
			label: "Excluded tags",
			placeholder: "Add tag",
			tone: "excluded",
			values: config.excludedTags,
			readOnly,
			onChange: t8
		});
		$[22] = config.excludedTags;
		$[23] = readOnly;
		$[24] = t8;
		$[25] = t9;
	} else t9 = $[25];
	let t10;
	if ($[26] !== update) {
		t10 = (next_3) => update("excludedPatterns", next_3);
		$[26] = update;
		$[27] = t10;
	} else t10 = $[27];
	let t11;
	if ($[28] !== config.excludedPatterns || $[29] !== readOnly || $[30] !== t10) {
		t11 = /* @__PURE__ */ jsx(PatternListInput, {
			label: "Excluded patterns",
			values: config.excludedPatterns,
			readOnly,
			onChange: t10
		});
		$[28] = config.excludedPatterns;
		$[29] = readOnly;
		$[30] = t10;
		$[31] = t11;
	} else t11 = $[31];
	let t12;
	if ($[32] !== t11 || $[33] !== t5 || $[34] !== t7 || $[35] !== t9) {
		t12 = /* @__PURE__ */ jsxs("div", {
			className: "space-y-3",
			children: [
				t5,
				t7,
				t9,
				t11
			]
		});
		$[32] = t11;
		$[33] = t5;
		$[34] = t7;
		$[35] = t9;
		$[36] = t12;
	} else t12 = $[36];
	return t12;
};
//#endregion
export { GroupedBacklinksDefaultsEditor };

//# sourceMappingURL=GroupedBacklinksConfigEditor.js.map