import { refTargetFilterDefaultsFacet } from "../../data/facets.js";
import { cn } from "../../lib/utils.js";
import { Input } from "../../components/ui/input.js";
import { Button } from "../../components/ui/button.js";
import { normalizeBacklinksFilter } from "./query.js";
import { truncate } from "../../utils/string.js";
import { labelForBlockData, searchLinkTargetIdCandidates } from "../../utils/linkTargetAutocomplete.js";
import { useRepo } from "../../context/repo.js";
import { useHandle } from "../../hooks/block.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { FunnelX } from "../../../node_modules/lucide-react/dist/esm/icons/funnel-x.js";
import { Plus } from "../../../node_modules/lucide-react/dist/esm/icons/plus.js";
import { Settings2 } from "../../../node_modules/lucide-react/dist/esm/icons/settings-2.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { usePropertySchemas } from "../../hooks/propertySchemas.js";
import { FloatingListbox } from "../../components/ui/floating-listbox.js";
import { useAutocompleteListbox } from "../../hooks/useAutocompleteListbox.js";
import { useDebouncedSearch } from "../../hooks/useDebouncedSearch.js";
import { propertyFilterOperatorArity, resolvePropertyFilter } from "./propertyFilter.js";
import { useId, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/backlinks/BacklinkFilters.tsx
var SEARCH_LIMIT = 6;
var DEBOUNCE_MS = 80;
var predicateKey = (p) => JSON.stringify(p);
var OPERATOR_LABELS = {
	eq: "=",
	lt: "<",
	lte: "≤",
	gt: ">",
	gte: "≥",
	between: "between",
	"exists-true": "is set",
	"exists-false": "is unset"
};
/** Render a `where[name]: value` clause as a short, human-readable
*  string for chips. Unwraps single-key `target` traversals so a chip
*  reads "next-review-date < 2026-05-18" rather than exposing the
*  internal ref-traversal shape. */
var formatPredicateClause = (name, value) => {
	if (value === null) return `${name}=∅`;
	if (value instanceof Date || typeof value !== "object") return `${name}=${formatScalar(value)}`;
	const entries = Object.entries(value);
	if (entries.length === 1) {
		const [op, operand] = entries[0];
		if (op === "target" && operand && typeof operand === "object") {
			const innerEntries = Object.entries(operand);
			if (innerEntries.length === 0) return `${name} is set`;
			if (innerEntries.length === 1) return formatPredicateClause(name, innerEntries[0][1]);
		}
		if (op === "exists") return operand === false ? `${name}=∅` : `${name} is set`;
		if (op === "between" && Array.isArray(operand) && operand.length === 2) return `${name} ∈ [${formatScalar(operand[0])}, ${formatScalar(operand[1])}]`;
		const sym = OPERATOR_LABELS[op];
		if (sym !== void 0) return `${name} ${sym} ${formatScalar(operand)}`;
	}
	return `${name}=${JSON.stringify(value)}`;
};
var formatScalar = (value) => {
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	if (value === null) return "∅";
	return String(value);
};
var RefChipBody = (t0) => {
	const $ = c(7);
	const { id } = t0;
	const repo = useRepo();
	let t1;
	if ($[0] !== id || $[1] !== repo) {
		t1 = repo.block(id);
		$[0] = id;
		$[1] = repo;
		$[2] = t1;
	} else t1 = $[2];
	const block = t1;
	let t2;
	if ($[3] !== id) {
		t2 = { selector: (data) => labelForBlockData(data, id) };
		$[3] = id;
		$[4] = t2;
	} else t2 = $[4];
	const label = useHandle(block, t2);
	let t3;
	if ($[5] !== label) {
		t3 = /* @__PURE__ */ jsx("span", {
			className: "truncate max-w-[18ch]",
			title: label,
			children: label
		});
		$[5] = label;
		$[6] = t3;
	} else t3 = $[6];
	return t3;
};
var ContainmentChipBody = (t0) => {
	const $ = c(7);
	const { id } = t0;
	const repo = useRepo();
	let t1;
	if ($[0] !== id || $[1] !== repo) {
		t1 = repo.block(id);
		$[0] = id;
		$[1] = repo;
		$[2] = t1;
	} else t1 = $[2];
	const block = t1;
	let t2;
	if ($[3] !== id) {
		t2 = { selector: (data) => labelForBlockData(data, id) };
		$[3] = id;
		$[4] = t2;
	} else t2 = $[4];
	const text = `in ${useHandle(block, t2)}`;
	let t3;
	if ($[5] !== text) {
		t3 = /* @__PURE__ */ jsx("span", {
			className: "truncate max-w-[18ch]",
			title: text,
			children: text
		});
		$[5] = text;
		$[6] = t3;
	} else t3 = $[6];
	return t3;
};
var WhereChipBody = (t0) => {
	const $ = c(4);
	const { where } = t0;
	let t1;
	if ($[0] !== where) {
		t1 = Object.entries(where).map(_temp);
		$[0] = where;
		$[1] = t1;
	} else t1 = $[1];
	const text = t1.join(", ");
	let t2;
	if ($[2] !== text) {
		t2 = /* @__PURE__ */ jsx("span", {
			className: "truncate max-w-[24ch]",
			title: text,
			children: text
		});
		$[2] = text;
		$[3] = t2;
	} else t2 = $[3];
	return t2;
};
var PredicateChip = (t0) => {
	const $ = c(16);
	const { predicate, mode, readOnly: t1, onRemove } = t0;
	const readOnly = t1 === void 0 ? false : t1;
	let body;
	if (predicate.referencedBy) {
		let t2;
		if ($[0] !== predicate.referencedBy.id) {
			t2 = /* @__PURE__ */ jsx(RefChipBody, { id: predicate.referencedBy.id });
			$[0] = predicate.referencedBy.id;
			$[1] = t2;
		} else t2 = $[1];
		body = t2;
	} else if (predicate.id !== void 0) {
		let t2;
		if ($[2] !== predicate.id) {
			t2 = /* @__PURE__ */ jsx(ContainmentChipBody, { id: predicate.id });
			$[2] = predicate.id;
			$[3] = t2;
		} else t2 = $[3];
		body = t2;
	} else if (predicate.where) {
		let t2;
		if ($[4] !== predicate.where) {
			t2 = /* @__PURE__ */ jsx(WhereChipBody, { where: predicate.where });
			$[4] = predicate.where;
			$[5] = t2;
		} else t2 = $[5];
		body = t2;
	} else {
		let t2;
		if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
			t2 = /* @__PURE__ */ jsx("span", { children: "?" });
			$[6] = t2;
		} else t2 = $[6];
		body = t2;
	}
	const t2 = mode === "include" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200" : "border-rose-500/30 bg-rose-500/10 text-rose-900 dark:text-rose-200";
	let t3;
	if ($[7] !== t2) {
		t3 = cn("inline-flex min-w-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs", t2);
		$[7] = t2;
		$[8] = t3;
	} else t3 = $[8];
	let t4;
	if ($[9] !== onRemove || $[10] !== readOnly) {
		t4 = !readOnly && /* @__PURE__ */ jsx("button", {
			type: "button",
			onClick: onRemove,
			className: "shrink-0 rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
			"aria-label": "Remove filter",
			children: /* @__PURE__ */ jsx(X, { className: "h-3 w-3" })
		});
		$[9] = onRemove;
		$[10] = readOnly;
		$[11] = t4;
	} else t4 = $[11];
	let t5;
	if ($[12] !== body || $[13] !== t3 || $[14] !== t4) {
		t5 = /* @__PURE__ */ jsxs("span", {
			className: t3,
			children: [body, t4]
		});
		$[12] = body;
		$[13] = t3;
		$[14] = t4;
		$[15] = t5;
	} else t5 = $[15];
	return t5;
};
var RefPredicateInput = (t0) => {
	const $ = c(83);
	const { workspaceId, mode, excludeIds, readOnly: t1, onAdd } = t0;
	const readOnly = t1 === void 0 ? false : t1;
	const repo = useRepo();
	const listboxId = useId();
	const [formElement, setFormElement] = useState(null);
	const [query, setQuery] = useState("");
	const [kind, setKind] = useState("refs");
	const [focused, setFocused] = useState(false);
	let t2;
	if ($[0] !== query) {
		t2 = query.trim();
		$[0] = query;
		$[1] = t2;
	} else t2 = $[1];
	const trimmed = t2;
	let t3;
	if ($[2] !== excludeIds || $[3] !== repo || $[4] !== workspaceId) {
		t3 = (q) => searchLinkTargetIdCandidates(repo, {
			workspaceId,
			query: q,
			limit: SEARCH_LIMIT,
			excludeIds
		});
		$[2] = excludeIds;
		$[3] = repo;
		$[4] = workspaceId;
		$[5] = t3;
	} else t3 = $[5];
	let t4;
	if ($[6] !== excludeIds || $[7] !== workspaceId) {
		t4 = [workspaceId, excludeIds];
		$[6] = excludeIds;
		$[7] = workspaceId;
		$[8] = t4;
	} else t4 = $[8];
	const { results, resultsQuery, reset: resetResults } = useDebouncedSearch({
		query,
		delayMs: DEBOUNCE_MS,
		enabled: Boolean(workspaceId),
		search: t3,
		onResults: () => setActiveIndex(0),
		revalidateOn: t4
	});
	const popupOpen = focused && trimmed.length > 0 && results.length > 0;
	let t5;
	if ($[9] !== kind || $[10] !== onAdd || $[11] !== readOnly || $[12] !== resetResults) {
		t5 = (id) => {
			if (readOnly) return;
			onAdd(kind, id);
			setQuery("");
			resetResults();
		};
		$[9] = kind;
		$[10] = onAdd;
		$[11] = readOnly;
		$[12] = resetResults;
		$[13] = t5;
	} else t5 = $[13];
	const commitId = t5;
	let t6;
	if ($[14] !== commitId || $[15] !== readOnly || $[16] !== repo || $[17] !== trimmed || $[18] !== workspaceId) {
		t6 = async () => {
			if (readOnly || !trimmed) return;
			const exact = await repo.query.aliasLookup({
				workspaceId,
				alias: trimmed
			}).load();
			if (exact) commitId(exact.id);
		};
		$[14] = commitId;
		$[15] = readOnly;
		$[16] = repo;
		$[17] = trimmed;
		$[18] = workspaceId;
		$[19] = t6;
	} else t6 = $[19];
	const commitTyped = t6;
	let t7;
	if ($[20] !== commitId || $[21] !== results) {
		t7 = (index) => {
			const candidate = results[index];
			if (!candidate) return false;
			commitId(candidate.id);
			return true;
		};
		$[20] = commitId;
		$[21] = results;
		$[22] = t7;
	} else t7 = $[22];
	let t8;
	if ($[23] !== listboxId || $[24] !== results.length || $[25] !== t7) {
		t8 = {
			itemCount: results.length,
			setOpen: setFocused,
			wrap: true,
			listboxId,
			onCommit: t7
		};
		$[23] = listboxId;
		$[24] = results.length;
		$[25] = t7;
		$[26] = t8;
	} else t8 = $[26];
	const { activeIndex, setActiveIndex: t9, activeDescendantId, onKeyDown, getOptionProps } = useAutocompleteListbox(t8);
	const setActiveIndex = t9;
	let t10;
	if ($[27] !== commitId || $[28] !== commitTyped || $[29] !== readOnly || $[30] !== results[0]?.id || $[31] !== resultsQuery || $[32] !== trimmed) {
		t10 = async (event) => {
			event.preventDefault();
			if (readOnly || !trimmed) return;
			const fallbackId = resultsQuery === trimmed ? results[0]?.id : void 0;
			if (fallbackId) {
				commitId(fallbackId);
				return;
			}
			await commitTyped();
		};
		$[27] = commitId;
		$[28] = commitTyped;
		$[29] = readOnly;
		$[30] = results[0]?.id;
		$[31] = resultsQuery;
		$[32] = trimmed;
		$[33] = t10;
	} else t10 = $[33];
	const handleSubmit = t10;
	let t11;
	if ($[34] === Symbol.for("react.memo_cache_sentinel")) {
		t11 = (e) => setKind(e.target.value);
		$[34] = t11;
	} else t11 = $[34];
	const t12 = kind === "refs" ? "Match blocks whose context references the selected block" : "Match blocks contained within the selected block";
	let t13;
	let t14;
	if ($[35] === Symbol.for("react.memo_cache_sentinel")) {
		t13 = /* @__PURE__ */ jsx("option", {
			value: "refs",
			children: "refs"
		});
		t14 = /* @__PURE__ */ jsx("option", {
			value: "contains",
			children: "in"
		});
		$[35] = t13;
		$[36] = t14;
	} else {
		t13 = $[35];
		t14 = $[36];
	}
	let t15;
	if ($[37] !== kind || $[38] !== readOnly || $[39] !== t12) {
		t15 = /* @__PURE__ */ jsxs("select", {
			value: kind,
			onChange: t11,
			disabled: readOnly,
			className: "h-8 shrink-0 rounded-md border bg-background px-1 text-xs",
			"aria-label": "Predicate kind",
			title: t12,
			children: [t13, t14]
		});
		$[37] = kind;
		$[38] = readOnly;
		$[39] = t12;
		$[40] = t15;
	} else t15 = $[40];
	let t16;
	if ($[41] !== resetResults) {
		t16 = (event_0) => {
			const next = event_0.target.value;
			setQuery(next);
			if (!next.trim()) resetResults();
		};
		$[41] = resetResults;
		$[42] = t16;
	} else t16 = $[42];
	let t17;
	let t18;
	if ($[43] === Symbol.for("react.memo_cache_sentinel")) {
		t17 = () => setFocused(true);
		t18 = () => setFocused(false);
		$[43] = t17;
		$[44] = t18;
	} else {
		t17 = $[43];
		t18 = $[44];
	}
	let t19;
	if ($[45] !== commitTyped || $[46] !== onKeyDown || $[47] !== resetResults || $[48] !== resultsQuery || $[49] !== trimmed) {
		t19 = (event_1) => {
			if (event_1.key === "Escape") {
				setQuery("");
				resetResults();
				return;
			}
			if (event_1.key === "Enter" && resultsQuery !== trimmed) {
				event_1.preventDefault();
				commitTyped();
				return;
			}
			onKeyDown(event_1);
		};
		$[45] = commitTyped;
		$[46] = onKeyDown;
		$[47] = resetResults;
		$[48] = resultsQuery;
		$[49] = trimmed;
		$[50] = t19;
	} else t19 = $[50];
	const t20 = mode === "include" ? "Include reference" : "Exclude reference";
	const t21 = Boolean(popupOpen);
	const t22 = popupOpen ? listboxId : void 0;
	const t23 = popupOpen ? activeDescendantId : void 0;
	let t24;
	if ($[51] !== query || $[52] !== readOnly || $[53] !== t16 || $[54] !== t19 || $[55] !== t20 || $[56] !== t21 || $[57] !== t22 || $[58] !== t23) {
		t24 = /* @__PURE__ */ jsx(Input, {
			value: query,
			onChange: t16,
			onFocus: t17,
			onBlur: t18,
			onKeyDown: t19,
			placeholder: t20,
			className: "h-8 min-w-0 text-xs",
			disabled: readOnly,
			role: "combobox",
			"aria-autocomplete": "list",
			"aria-expanded": t21,
			"aria-controls": t22,
			"aria-activedescendant": t23
		});
		$[51] = query;
		$[52] = readOnly;
		$[53] = t16;
		$[54] = t19;
		$[55] = t20;
		$[56] = t21;
		$[57] = t22;
		$[58] = t23;
		$[59] = t24;
	} else t24 = $[59];
	const t25 = mode === "include" ? "Add include filter" : "Add exclude filter";
	const t26 = mode === "include" ? "Add include filter" : "Add exclude filter";
	let t27;
	if ($[60] === Symbol.for("react.memo_cache_sentinel")) {
		t27 = /* @__PURE__ */ jsx(Plus, { className: "h-4 w-4" });
		$[60] = t27;
	} else t27 = $[60];
	let t28;
	if ($[61] !== readOnly || $[62] !== t25 || $[63] !== t26) {
		t28 = /* @__PURE__ */ jsx(Button, {
			type: "submit",
			variant: "ghost",
			size: "icon",
			className: "h-8 w-8 shrink-0",
			disabled: readOnly,
			title: t25,
			"aria-label": t26,
			children: t27
		});
		$[61] = readOnly;
		$[62] = t25;
		$[63] = t26;
		$[64] = t28;
	} else t28 = $[64];
	let t29;
	if ($[65] !== activeIndex || $[66] !== getOptionProps || $[67] !== results) {
		let t30;
		if ($[69] !== activeIndex || $[70] !== getOptionProps) {
			t30 = (result, index_0) => /* @__PURE__ */ jsxs("button", {
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
			}, result.id);
			$[69] = activeIndex;
			$[70] = getOptionProps;
			$[71] = t30;
		} else t30 = $[71];
		t29 = results.map(t30);
		$[65] = activeIndex;
		$[66] = getOptionProps;
		$[67] = results;
		$[68] = t29;
	} else t29 = $[68];
	let t30;
	if ($[72] !== formElement || $[73] !== listboxId || $[74] !== popupOpen || $[75] !== t29) {
		t30 = /* @__PURE__ */ jsx(FloatingListbox, {
			id: listboxId,
			open: popupOpen,
			anchorElement: formElement,
			maxWidth: 384,
			maxHeight: 224,
			className: "text-xs shadow-md",
			children: t29
		});
		$[72] = formElement;
		$[73] = listboxId;
		$[74] = popupOpen;
		$[75] = t29;
		$[76] = t30;
	} else t30 = $[76];
	let t31;
	if ($[77] !== handleSubmit || $[78] !== t15 || $[79] !== t24 || $[80] !== t28 || $[81] !== t30) {
		t31 = /* @__PURE__ */ jsxs("form", {
			ref: setFormElement,
			className: "flex min-w-0 flex-1 gap-1",
			onSubmit: handleSubmit,
			children: [
				t15,
				t24,
				t28,
				t30
			]
		});
		$[77] = handleSubmit;
		$[78] = t15;
		$[79] = t24;
		$[80] = t28;
		$[81] = t30;
		$[82] = t31;
	} else t31 = $[82];
	return t31;
};
var htmlInputType = (kind) => kind === "date" ? "date" : kind === "number" ? "number" : "text";
var PropertyPredicateInput = (t0) => {
	const $ = c(72);
	const { mode, readOnly: t1, onAdd } = t0;
	const readOnly = t1 === void 0 ? false : t1;
	const schemas = usePropertySchemas();
	const runtime = useAppRuntime();
	let t2;
	if ($[0] !== runtime) {
		t2 = runtime.read(refTargetFilterDefaultsFacet);
		$[0] = runtime;
		$[1] = t2;
	} else t2 = $[1];
	const refTargetDefaults = t2;
	let t3;
	if ($[2] !== schemas) {
		t3 = Array.from(schemas.values()).sort(_temp2);
		$[2] = schemas;
		$[3] = t3;
	} else t3 = $[3];
	const queryable = t3;
	const [name, setName] = useState("");
	const [op, setOp] = useState("eq");
	const [value, setValue] = useState("");
	const [valueHi, setValueHi] = useState("");
	let t4;
	if ($[4] !== name || $[5] !== schemas) {
		t4 = schemas.get(name);
		$[4] = name;
		$[5] = schemas;
		$[6] = t4;
	} else t4 = $[6];
	const schema = t4;
	let t5;
	if ($[7] !== refTargetDefaults || $[8] !== schema || $[9] !== schemas) {
		t5 = schema ? resolvePropertyFilter(schema, schemas, refTargetDefaults) : void 0;
		$[7] = refTargetDefaults;
		$[8] = schema;
		$[9] = schemas;
		$[10] = t5;
	} else t5 = $[10];
	const affordance = t5;
	const arity = propertyFilterOperatorArity(op);
	const inputKind = affordance?.inputKind ?? "text";
	let t6;
	if ($[11] !== inputKind) {
		t6 = htmlInputType(inputKind);
		$[11] = inputKind;
		$[12] = t6;
	} else t6 = $[12];
	const inputType = t6;
	let t7;
	if ($[13] !== refTargetDefaults || $[14] !== schemas) {
		t7 = (propertyName) => {
			const nextSchema = schemas.get(propertyName);
			if (!nextSchema) return "eq";
			return resolvePropertyFilter(nextSchema, schemas, refTargetDefaults).operators[0] ?? "eq";
		};
		$[13] = refTargetDefaults;
		$[14] = schemas;
		$[15] = t7;
	} else t7 = $[15];
	const defaultOperatorFor = t7;
	let t8;
	if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
		t8 = () => {
			setName("");
			setOp("eq");
			setValue("");
			setValueHi("");
		};
		$[16] = t8;
	} else t8 = $[16];
	const reset = t8;
	let t9;
	if ($[17] !== affordance || $[18] !== arity || $[19] !== name || $[20] !== onAdd || $[21] !== op || $[22] !== readOnly || $[23] !== schema || $[24] !== value || $[25] !== valueHi) {
		t9 = (event) => {
			event.preventDefault();
			if (readOnly || !schema || !affordance) return;
			const rawValues = arity === 2 ? [value, valueHi] : arity === 1 ? [value] : [];
			const predicate = affordance.build(name, op, rawValues);
			if (!predicate) return;
			onAdd(predicate);
			reset();
		};
		$[17] = affordance;
		$[18] = arity;
		$[19] = name;
		$[20] = onAdd;
		$[21] = op;
		$[22] = readOnly;
		$[23] = schema;
		$[24] = value;
		$[25] = valueHi;
		$[26] = t9;
	} else t9 = $[26];
	const submit = t9;
	if (queryable.length === 0) return null;
	const valueAriaLabel = mode === "include" ? "Include value" : "Exclude value";
	let t10;
	if ($[27] !== affordance?.operators) {
		t10 = affordance?.operators ?? [];
		$[27] = affordance?.operators;
		$[28] = t10;
	} else t10 = $[28];
	const operators = t10;
	let t11;
	if ($[29] !== defaultOperatorFor) {
		t11 = (e) => {
			const nextName = e.target.value;
			setName(nextName);
			setOp(defaultOperatorFor(nextName));
			setValue("");
			setValueHi("");
		};
		$[29] = defaultOperatorFor;
		$[30] = t11;
	} else t11 = $[30];
	const t12 = mode === "include" ? "Include property" : "Exclude property";
	let t13;
	if ($[31] === Symbol.for("react.memo_cache_sentinel")) {
		t13 = /* @__PURE__ */ jsx("option", {
			value: "",
			children: "— property —"
		});
		$[31] = t13;
	} else t13 = $[31];
	let t14;
	if ($[32] !== queryable) {
		t14 = queryable.map(_temp3);
		$[32] = queryable;
		$[33] = t14;
	} else t14 = $[33];
	let t15;
	if ($[34] !== name || $[35] !== readOnly || $[36] !== t11 || $[37] !== t12 || $[38] !== t14) {
		t15 = /* @__PURE__ */ jsxs("select", {
			value: name,
			onChange: t11,
			disabled: readOnly,
			className: "h-8 min-w-0 rounded-md border bg-background px-2 text-xs",
			"aria-label": t12,
			children: [t13, t14]
		});
		$[34] = name;
		$[35] = readOnly;
		$[36] = t11;
		$[37] = t12;
		$[38] = t14;
		$[39] = t15;
	} else t15 = $[39];
	let t16;
	if ($[40] !== op || $[41] !== operators || $[42] !== readOnly || $[43] !== schema) {
		t16 = schema && operators.length > 1 && /* @__PURE__ */ jsx("select", {
			value: op,
			onChange: (e_0) => setOp(e_0.target.value),
			disabled: readOnly,
			className: "h-8 min-w-0 rounded-md border bg-background px-2 text-xs",
			"aria-label": "operator",
			children: operators.map(_temp4)
		});
		$[40] = op;
		$[41] = operators;
		$[42] = readOnly;
		$[43] = schema;
		$[44] = t16;
	} else t16 = $[44];
	let t17;
	if ($[45] !== arity || $[46] !== inputKind || $[47] !== inputType || $[48] !== readOnly || $[49] !== schema || $[50] !== value || $[51] !== valueAriaLabel) {
		t17 = inputKind === "boolean" && arity === 1 ? /* @__PURE__ */ jsxs("select", {
			value,
			onChange: (e_1) => setValue(e_1.target.value),
			disabled: readOnly,
			className: "h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs",
			"aria-label": valueAriaLabel,
			children: [
				/* @__PURE__ */ jsx("option", {
					value: "",
					children: "(unset)"
				}),
				/* @__PURE__ */ jsx("option", {
					value: "true",
					children: "true"
				}),
				/* @__PURE__ */ jsx("option", {
					value: "false",
					children: "false"
				})
			]
		}) : arity >= 1 ? /* @__PURE__ */ jsx(Input, {
			type: inputType,
			value,
			onChange: (e_2) => setValue(e_2.target.value),
			disabled: readOnly || !schema,
			placeholder: schema ? inputType === "text" ? schema.codec.type : inputType : "value",
			className: "h-8 min-w-0 flex-1 text-xs",
			"aria-label": valueAriaLabel
		}) : null;
		$[45] = arity;
		$[46] = inputKind;
		$[47] = inputType;
		$[48] = readOnly;
		$[49] = schema;
		$[50] = value;
		$[51] = valueAriaLabel;
		$[52] = t17;
	} else t17 = $[52];
	let t18;
	if ($[53] !== arity || $[54] !== inputType || $[55] !== readOnly || $[56] !== schema || $[57] !== valueAriaLabel || $[58] !== valueHi) {
		t18 = arity === 2 && /* @__PURE__ */ jsx(Input, {
			type: inputType,
			value: valueHi,
			onChange: (e_3) => setValueHi(e_3.target.value),
			disabled: readOnly || !schema,
			placeholder: "and",
			className: "h-8 min-w-0 flex-1 text-xs",
			"aria-label": `${valueAriaLabel} (upper bound)`
		});
		$[53] = arity;
		$[54] = inputType;
		$[55] = readOnly;
		$[56] = schema;
		$[57] = valueAriaLabel;
		$[58] = valueHi;
		$[59] = t18;
	} else t18 = $[59];
	const t19 = readOnly || !schema;
	const t20 = mode === "include" ? "Add include property filter" : "Add exclude property filter";
	const t21 = mode === "include" ? "Add include property filter" : "Add exclude property filter";
	let t22;
	if ($[60] === Symbol.for("react.memo_cache_sentinel")) {
		t22 = /* @__PURE__ */ jsx(Plus, { className: "h-4 w-4" });
		$[60] = t22;
	} else t22 = $[60];
	let t23;
	if ($[61] !== t19 || $[62] !== t20 || $[63] !== t21) {
		t23 = /* @__PURE__ */ jsx(Button, {
			type: "submit",
			variant: "ghost",
			size: "icon",
			className: "h-8 w-8 shrink-0",
			disabled: t19,
			title: t20,
			"aria-label": t21,
			children: t22
		});
		$[61] = t19;
		$[62] = t20;
		$[63] = t21;
		$[64] = t23;
	} else t23 = $[64];
	let t24;
	if ($[65] !== submit || $[66] !== t15 || $[67] !== t16 || $[68] !== t17 || $[69] !== t18 || $[70] !== t23) {
		t24 = /* @__PURE__ */ jsxs("form", {
			className: "flex min-w-0 gap-1",
			onSubmit: submit,
			children: [
				t15,
				t16,
				t17,
				t18,
				t23
			]
		});
		$[65] = submit;
		$[66] = t15;
		$[67] = t16;
		$[68] = t17;
		$[69] = t18;
		$[70] = t23;
		$[71] = t24;
	} else t24 = $[71];
	return t24;
};
function BacklinkFilters(t0) {
	const $ = c(76);
	const { workspaceId, filter, onChange, baseFilter, baseLabel: t1, baseConfigLabel: t2, onBaseConfigClick, readOnly: t3 } = t0;
	const baseLabel = t1 === void 0 ? "Defaults" : t1;
	const baseConfigLabel = t2 === void 0 ? "Open defaults config" : t2;
	const readOnly = t3 === void 0 ? false : t3;
	let t4;
	if ($[0] !== filter) {
		t4 = normalizeBacklinksFilter(filter);
		$[0] = filter;
		$[1] = t4;
	} else t4 = $[1];
	const normalized = t4;
	let t5;
	if ($[2] !== baseFilter) {
		t5 = normalizeBacklinksFilter(baseFilter);
		$[2] = baseFilter;
		$[3] = t5;
	} else t5 = $[3];
	const normalizedBase = t5;
	const active = normalized.include.length > 0 || normalized.exclude.length > 0;
	const baseActive = normalizedBase.include.length > 0 || normalizedBase.exclude.length > 0;
	const refIdsInList = _temp5;
	let t6;
	if ($[4] !== normalized.include) {
		t6 = refIdsInList(normalized.include);
		$[4] = normalized.include;
		$[5] = t6;
	} else t6 = $[5];
	const includeRefIds = t6;
	let t7;
	if ($[6] !== normalized.exclude) {
		t7 = refIdsInList(normalized.exclude);
		$[6] = normalized.exclude;
		$[7] = t7;
	} else t7 = $[7];
	const excludeRefIds = t7;
	let t8;
	if ($[8] !== normalized.exclude || $[9] !== normalized.include || $[10] !== onChange || $[11] !== readOnly) {
		t8 = (mode, predicate) => {
			if (readOnly) return;
			const key = predicateKey(predicate);
			onChange({
				include: mode === "include" ? [predicate, ...normalized.include.filter((p_0) => predicateKey(p_0) !== key)] : normalized.include.filter((p_1) => predicateKey(p_1) !== key),
				exclude: mode === "exclude" ? [predicate, ...normalized.exclude.filter((p_2) => predicateKey(p_2) !== key)] : normalized.exclude.filter((p_3) => predicateKey(p_3) !== key)
			});
		};
		$[8] = normalized.exclude;
		$[9] = normalized.include;
		$[10] = onChange;
		$[11] = readOnly;
		$[12] = t8;
	} else t8 = $[12];
	const addPredicate = t8;
	let t9;
	if ($[13] !== normalized.exclude || $[14] !== normalized.include || $[15] !== onChange || $[16] !== readOnly) {
		t9 = (mode_0, predicate_0) => {
			if (readOnly) return;
			const key_0 = predicateKey(predicate_0);
			onChange({
				include: mode_0 === "include" ? normalized.include.filter((p_4) => predicateKey(p_4) !== key_0) : normalized.include,
				exclude: mode_0 === "exclude" ? normalized.exclude.filter((p_5) => predicateKey(p_5) !== key_0) : normalized.exclude
			});
		};
		$[13] = normalized.exclude;
		$[14] = normalized.include;
		$[15] = onChange;
		$[16] = readOnly;
		$[17] = t9;
	} else t9 = $[17];
	const removePredicate = t9;
	let t10;
	if ($[18] !== baseActive || $[19] !== baseConfigLabel || $[20] !== baseLabel || $[21] !== normalizedBase.exclude || $[22] !== normalizedBase.include || $[23] !== onBaseConfigClick) {
		t10 = baseActive && /* @__PURE__ */ jsxs("div", {
			className: "flex min-w-0 flex-col gap-1.5",
			children: [/* @__PURE__ */ jsxs("div", {
				className: "flex min-w-0 items-center gap-1.5",
				children: [/* @__PURE__ */ jsx("div", {
					className: "text-xs font-medium text-muted-foreground",
					children: baseLabel
				}), onBaseConfigClick && /* @__PURE__ */ jsx("button", {
					type: "button",
					onClick: onBaseConfigClick,
					className: "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
					title: baseConfigLabel,
					"aria-label": baseConfigLabel,
					children: /* @__PURE__ */ jsx(Settings2, { className: "h-3.5 w-3.5" })
				})]
			}), /* @__PURE__ */ jsxs("div", {
				className: "grid gap-2 md:grid-cols-2",
				children: [/* @__PURE__ */ jsx("div", {
					className: "flex min-w-0 flex-wrap gap-1",
					children: normalizedBase.include.map(_temp7)
				}), /* @__PURE__ */ jsx("div", {
					className: "flex min-w-0 flex-wrap gap-1",
					children: normalizedBase.exclude.map(_temp9)
				})]
			})]
		});
		$[18] = baseActive;
		$[19] = baseConfigLabel;
		$[20] = baseLabel;
		$[21] = normalizedBase.exclude;
		$[22] = normalizedBase.include;
		$[23] = onBaseConfigClick;
		$[24] = t10;
	} else t10 = $[24];
	let t11;
	if ($[25] !== addPredicate) {
		t11 = (kind, id) => addPredicate("include", kind === "refs" ? {
			scope: "ancestor",
			referencedBy: { id }
		} : {
			scope: "ancestor",
			id
		});
		$[25] = addPredicate;
		$[26] = t11;
	} else t11 = $[26];
	let t12;
	if ($[27] !== includeRefIds || $[28] !== readOnly || $[29] !== t11 || $[30] !== workspaceId) {
		t12 = /* @__PURE__ */ jsx(RefPredicateInput, {
			workspaceId,
			mode: "include",
			excludeIds: includeRefIds,
			readOnly,
			onAdd: t11
		});
		$[27] = includeRefIds;
		$[28] = readOnly;
		$[29] = t11;
		$[30] = workspaceId;
		$[31] = t12;
	} else t12 = $[31];
	let t13;
	if ($[32] !== addPredicate) {
		t13 = (p_8) => addPredicate("include", p_8);
		$[32] = addPredicate;
		$[33] = t13;
	} else t13 = $[33];
	let t14;
	if ($[34] !== readOnly || $[35] !== t13) {
		t14 = /* @__PURE__ */ jsx(PropertyPredicateInput, {
			mode: "include",
			readOnly,
			onAdd: t13
		});
		$[34] = readOnly;
		$[35] = t13;
		$[36] = t14;
	} else t14 = $[36];
	let t15;
	if ($[37] !== normalized.include || $[38] !== readOnly || $[39] !== removePredicate) {
		t15 = normalized.include.length > 0 && /* @__PURE__ */ jsx("div", {
			className: "flex min-w-0 flex-wrap gap-1",
			children: normalized.include.map((p_9) => /* @__PURE__ */ jsx(PredicateChip, {
				predicate: p_9,
				mode: "include",
				readOnly,
				onRemove: () => removePredicate("include", p_9)
			}, `inc-${predicateKey(p_9)}`))
		});
		$[37] = normalized.include;
		$[38] = readOnly;
		$[39] = removePredicate;
		$[40] = t15;
	} else t15 = $[40];
	let t16;
	if ($[41] !== t12 || $[42] !== t14 || $[43] !== t15) {
		t16 = /* @__PURE__ */ jsxs("div", {
			className: "flex min-w-0 flex-col gap-1.5",
			children: [
				t12,
				t14,
				t15
			]
		});
		$[41] = t12;
		$[42] = t14;
		$[43] = t15;
		$[44] = t16;
	} else t16 = $[44];
	let t17;
	if ($[45] !== addPredicate) {
		t17 = (kind_0, id_0) => addPredicate("exclude", kind_0 === "refs" ? {
			scope: "ancestor",
			referencedBy: { id: id_0 }
		} : {
			scope: "ancestor",
			id: id_0
		});
		$[45] = addPredicate;
		$[46] = t17;
	} else t17 = $[46];
	let t18;
	if ($[47] !== excludeRefIds || $[48] !== readOnly || $[49] !== t17 || $[50] !== workspaceId) {
		t18 = /* @__PURE__ */ jsx(RefPredicateInput, {
			workspaceId,
			mode: "exclude",
			excludeIds: excludeRefIds,
			readOnly,
			onAdd: t17
		});
		$[47] = excludeRefIds;
		$[48] = readOnly;
		$[49] = t17;
		$[50] = workspaceId;
		$[51] = t18;
	} else t18 = $[51];
	let t19;
	if ($[52] !== addPredicate) {
		t19 = (p_10) => addPredicate("exclude", p_10);
		$[52] = addPredicate;
		$[53] = t19;
	} else t19 = $[53];
	let t20;
	if ($[54] !== readOnly || $[55] !== t19) {
		t20 = /* @__PURE__ */ jsx(PropertyPredicateInput, {
			mode: "exclude",
			readOnly,
			onAdd: t19
		});
		$[54] = readOnly;
		$[55] = t19;
		$[56] = t20;
	} else t20 = $[56];
	let t21;
	if ($[57] !== normalized.exclude || $[58] !== readOnly || $[59] !== removePredicate) {
		t21 = normalized.exclude.length > 0 && /* @__PURE__ */ jsx("div", {
			className: "flex min-w-0 flex-wrap gap-1",
			children: normalized.exclude.map((p_11) => /* @__PURE__ */ jsx(PredicateChip, {
				predicate: p_11,
				mode: "exclude",
				readOnly,
				onRemove: () => removePredicate("exclude", p_11)
			}, `exc-${predicateKey(p_11)}`))
		});
		$[57] = normalized.exclude;
		$[58] = readOnly;
		$[59] = removePredicate;
		$[60] = t21;
	} else t21 = $[60];
	let t22;
	if ($[61] !== t18 || $[62] !== t20 || $[63] !== t21) {
		t22 = /* @__PURE__ */ jsxs("div", {
			className: "flex min-w-0 flex-col gap-1.5",
			children: [
				t18,
				t20,
				t21
			]
		});
		$[61] = t18;
		$[62] = t20;
		$[63] = t21;
		$[64] = t22;
	} else t22 = $[64];
	let t23;
	if ($[65] !== t16 || $[66] !== t22) {
		t23 = /* @__PURE__ */ jsxs("div", {
			className: "grid gap-2 md:grid-cols-2",
			children: [t16, t22]
		});
		$[65] = t16;
		$[66] = t22;
		$[67] = t23;
	} else t23 = $[67];
	let t24;
	if ($[68] !== active || $[69] !== onChange || $[70] !== readOnly) {
		t24 = active && /* @__PURE__ */ jsx("div", { children: /* @__PURE__ */ jsxs(Button, {
			type: "button",
			variant: "ghost",
			size: "sm",
			className: "h-7 gap-1 px-2 text-xs text-muted-foreground",
			disabled: readOnly,
			onClick: () => onChange({}),
			children: [/* @__PURE__ */ jsx(FunnelX, { className: "h-3.5 w-3.5" }), "Clear"]
		}) });
		$[68] = active;
		$[69] = onChange;
		$[70] = readOnly;
		$[71] = t24;
	} else t24 = $[71];
	let t25;
	if ($[72] !== t10 || $[73] !== t23 || $[74] !== t24) {
		t25 = /* @__PURE__ */ jsxs("div", {
			className: "mt-3 flex flex-col gap-2 border-l border-border/80 pl-3",
			children: [
				t10,
				t23,
				t24
			]
		});
		$[72] = t10;
		$[73] = t23;
		$[74] = t24;
		$[75] = t25;
	} else t25 = $[75];
	return t25;
}
function _temp9(p_7) {
	return /* @__PURE__ */ jsx(PredicateChip, {
		predicate: p_7,
		mode: "exclude",
		readOnly: true,
		onRemove: _temp8
	}, `base-exc-${predicateKey(p_7)}`);
}
function _temp8() {}
function _temp7(p_6) {
	return /* @__PURE__ */ jsx(PredicateChip, {
		predicate: p_6,
		mode: "include",
		readOnly: true,
		onRemove: _temp6
	}, `base-inc-${predicateKey(p_6)}`);
}
function _temp6() {}
function _temp5(predicates) {
	const out = /* @__PURE__ */ new Set();
	for (const p of predicates) {
		if (p.referencedBy) out.add(p.referencedBy.id);
		if (p.id !== void 0) out.add(p.id);
	}
	return out;
}
function _temp(t0) {
	const [name, value] = t0;
	return formatPredicateClause(name, value);
}
function _temp2(a, b) {
	return a.name.localeCompare(b.name);
}
function _temp3(s) {
	return /* @__PURE__ */ jsx("option", {
		value: s.name,
		children: s.name
	}, s.name);
}
function _temp4(o) {
	return /* @__PURE__ */ jsx("option", {
		value: o,
		children: OPERATOR_LABELS[o]
	}, o);
}
//#endregion
export { BacklinkFilters };

//# sourceMappingURL=BacklinkFilters.js.map