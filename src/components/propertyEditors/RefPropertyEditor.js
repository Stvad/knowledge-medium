import { isRefCodec, isRefListCodec } from "../../data/api/codecs.js";
import "../../data/api/index.js";
import { getBlockTypes } from "../../data/properties.js";
import { Block } from "../../data/block.js";
import { labelForBlockData, searchLinkTargetIdCandidates } from "../../utils/linkTargetAutocomplete.js";
import { useWorkspaceId } from "../../hooks/block.js";
import { Plus } from "../../../node_modules/lucide-react/dist/esm/icons/plus.js";
import { Search } from "../../../node_modules/lucide-react/dist/esm/icons/search.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { FloatingListbox } from "../ui/floating-listbox.js";
import { useAutocompleteListbox } from "../../hooks/useAutocompleteListbox.js";
import { NestedBlockContextProvider, useBlockContext } from "../../context/block.js";
import { BlockRefAncestorsProvider } from "../references/cycleGuard.js";
import { BlockEmbed } from "../references/BlockEmbed.js";
import { useEffect, useId, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/propertyEditors/RefPropertyEditor.tsx
var SEARCH_LIMIT = 12;
var EMPTY_REFS = Object.freeze([]);
var normalizeId = (value) => typeof value === "string" ? value.trim() : "";
var normalizeIds = (value) => Array.from(new Set(value.map(normalizeId).filter(Boolean)));
var targetTypesForSchema = (schema) => {
	if (!schema) return EMPTY_REFS;
	if (isRefCodec(schema.codec) || isRefListCodec(schema.codec)) return schema.codec.targetTypes;
	return EMPTY_REFS;
};
var compactDetail = (text) => text.replace(/\s+/g, " ").trim();
var candidateLabel = (candidate) => compactDetail(candidate.label) || candidate.id;
var candidateDetail = (candidate) => compactDetail(candidate.detail);
var blockMatchesTargetTypes = async (repo, blockId, targetTypes) => {
	if (targetTypes.length === 0) return true;
	const data = await repo.block(blockId).load();
	if (!data) return false;
	const types = getBlockTypes(data);
	return targetTypes.some((type) => types.includes(type));
};
var filterByTargetTypes = async (repo, candidates, targetTypes) => {
	if (targetTypes.length === 0) return [...candidates];
	return (await Promise.all(candidates.map(async (candidate) => ({
		candidate,
		matches: await blockMatchesTargetTypes(repo, candidate.id, targetTypes)
	})))).filter((check) => check.matches).map((check) => check.candidate);
};
var searchReferenceCandidates = async (repo, { workspaceId, query, excludeIds, targetTypes }) => {
	if (!workspaceId) return [];
	const excluded = new Set(Array.from(excludeIds).map(normalizeId).filter(Boolean));
	const trimmed = query.trim();
	let candidates;
	if (trimmed) candidates = await searchLinkTargetIdCandidates(repo, {
		workspaceId,
		query: trimmed,
		limit: SEARCH_LIMIT,
		excludeIds: excluded
	});
	else {
		const [aliasRows, recentBlocks] = await Promise.all([repo.query.aliasMatches({
			workspaceId,
			filter: "",
			limit: SEARCH_LIMIT
		}).load(), repo.query.recentBlocks({
			workspaceId,
			limit: SEARCH_LIMIT
		}).load()]);
		const seen = new Set(excluded);
		candidates = [];
		for (const row of aliasRows) {
			if (seen.has(row.blockId)) continue;
			seen.add(row.blockId);
			candidates.push({
				id: row.blockId,
				label: row.alias,
				detail: row.content
			});
		}
		for (const block of recentBlocks ?? []) {
			if (seen.has(block.id)) continue;
			seen.add(block.id);
			candidates.push({
				id: block.id,
				label: labelForBlockData(block, block.id),
				detail: block.content
			});
		}
	}
	return (await filterByTargetTypes(repo, candidates, targetTypes)).slice(0, SEARCH_LIMIT);
};
function ReferenceEmbed(t0) {
	const $ = c(18);
	const { owner, blockId, readOnly, onRemove } = t0;
	const panelId = useBlockContext().panelId ?? `property:${owner.id}`;
	let t1;
	if ($[0] !== panelId) {
		t1 = { panelId };
		$[0] = panelId;
		$[1] = t1;
	} else t1 = $[1];
	const t2 = `property:${owner.id}:${blockId}`;
	let t3;
	if ($[2] !== blockId || $[3] !== owner.id || $[4] !== t2) {
		t3 = /* @__PURE__ */ jsx(BlockEmbed, {
			blockId,
			sourceBlockId: owner.id,
			occurrenceId: t2
		});
		$[2] = blockId;
		$[3] = owner.id;
		$[4] = t2;
		$[5] = t3;
	} else t3 = $[5];
	let t4;
	if ($[6] !== owner.id || $[7] !== t3) {
		t4 = /* @__PURE__ */ jsx(BlockRefAncestorsProvider, {
			ancestor: owner.id,
			children: t3
		});
		$[6] = owner.id;
		$[7] = t3;
		$[8] = t4;
	} else t4 = $[8];
	let t5;
	if ($[9] !== t1 || $[10] !== t4) {
		t5 = /* @__PURE__ */ jsx(NestedBlockContextProvider, {
			overrides: t1,
			children: t4
		});
		$[9] = t1;
		$[10] = t4;
		$[11] = t5;
	} else t5 = $[11];
	let t6;
	if ($[12] !== onRemove || $[13] !== readOnly) {
		t6 = !readOnly && /* @__PURE__ */ jsx("button", {
			type: "button",
			className: "absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-muted hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/ref:opacity-100",
			"aria-label": "Remove block reference",
			onClick: (event) => {
				event.preventDefault();
				event.stopPropagation();
				onRemove();
			},
			children: /* @__PURE__ */ jsx(X, { className: "h-3.5 w-3.5" })
		});
		$[12] = onRemove;
		$[13] = readOnly;
		$[14] = t6;
	} else t6 = $[14];
	let t7;
	if ($[15] !== t5 || $[16] !== t6) {
		t7 = /* @__PURE__ */ jsxs("div", {
			className: "group/ref relative min-w-0 rounded-md border border-border/40 bg-background/60 pr-8",
			children: [t5, t6]
		});
		$[15] = t5;
		$[16] = t6;
		$[17] = t7;
	} else t7 = $[17];
	return t7;
}
function EmptyReference() {
	const $ = c(1);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = /* @__PURE__ */ jsx("div", {
			className: "h-7 truncate py-1 text-sm text-muted-foreground/55",
			children: "Empty"
		});
		$[0] = t0;
	} else t0 = $[0];
	return t0;
}
function ReferenceSearch(t0) {
	const $ = c(46);
	const { owner, excludeIds, targetTypes, placeholder, selectionMode, onPick } = t0;
	const listboxId = useId();
	const [shellElement, setShellElement] = useState(null);
	const workspaceId = useWorkspaceId(owner, owner.repo.activeWorkspaceId ?? "");
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = [];
		$[0] = t1;
	} else t1 = $[0];
	const [candidates, setCandidates] = useState(t1);
	let t2;
	if ($[1] !== excludeIds) {
		t2 = normalizeIds(excludeIds);
		$[1] = excludeIds;
		$[2] = t2;
	} else t2 = $[2];
	const normalizedExcludeIds = t2;
	let t3;
	if ($[3] !== onPick) {
		t3 = (candidate) => {
			onPick(candidate.id);
			setQuery("");
			setOpen(false);
		};
		$[3] = onPick;
		$[4] = t3;
	} else t3 = $[4];
	const pick = t3;
	let t4;
	if ($[5] !== candidates || $[6] !== pick) {
		t4 = (index) => {
			const candidate_0 = candidates[index];
			if (!candidate_0) return false;
			pick(candidate_0);
			return true;
		};
		$[5] = candidates;
		$[6] = pick;
		$[7] = t4;
	} else t4 = $[7];
	let t5;
	if ($[8] !== candidates.length || $[9] !== t4) {
		t5 = {
			itemCount: candidates.length,
			setOpen,
			commitOnTab: true,
			onCommit: t4
		};
		$[8] = candidates.length;
		$[9] = t4;
		$[10] = t5;
	} else t5 = $[10];
	const { activeIndex, setActiveIndex, onKeyDown, getOptionProps } = useAutocompleteListbox(t5);
	let t6;
	let t7;
	if ($[11] !== normalizedExcludeIds || $[12] !== open || $[13] !== owner.repo || $[14] !== query || $[15] !== setActiveIndex || $[16] !== targetTypes || $[17] !== workspaceId) {
		t6 = () => {
			if (!open) return;
			let cancelled = false;
			Promise.resolve().then(() => {
				if (!cancelled) setLoading(true);
				return searchReferenceCandidates(owner.repo, {
					workspaceId,
					query,
					excludeIds: normalizedExcludeIds,
					targetTypes
				});
			}).then((next) => {
				if (cancelled) return;
				setCandidates(next);
				setActiveIndex(0);
			}).catch((error) => {
				if (!cancelled) {
					console.error("[RefPropertyEditor] block search failed", error);
					setCandidates([]);
				}
			}).finally(() => {
				if (!cancelled) setLoading(false);
			});
			return () => {
				cancelled = true;
			};
		};
		t7 = [
			normalizedExcludeIds,
			open,
			owner.repo,
			query,
			setActiveIndex,
			targetTypes,
			workspaceId
		];
		$[11] = normalizedExcludeIds;
		$[12] = open;
		$[13] = owner.repo;
		$[14] = query;
		$[15] = setActiveIndex;
		$[16] = targetTypes;
		$[17] = workspaceId;
		$[18] = t6;
		$[19] = t7;
	} else {
		t6 = $[18];
		t7 = $[19];
	}
	useEffect(t6, t7);
	let t8;
	if ($[20] === Symbol.for("react.memo_cache_sentinel")) {
		t8 = () => {
			window.setTimeout(() => setOpen(false), 120);
		};
		$[20] = t8;
	} else t8 = $[20];
	let t9;
	if ($[21] === Symbol.for("react.memo_cache_sentinel")) {
		t9 = /* @__PURE__ */ jsx(Search, { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" });
		$[21] = t9;
	} else t9 = $[21];
	let t10;
	let t11;
	if ($[22] === Symbol.for("react.memo_cache_sentinel")) {
		t10 = () => setOpen(true);
		t11 = (event) => {
			setQuery(event.target.value);
			setOpen(true);
		};
		$[22] = t10;
		$[23] = t11;
	} else {
		t10 = $[22];
		t11 = $[23];
	}
	let t12;
	if ($[24] !== onKeyDown) {
		t12 = (event_0) => {
			if (event_0.key === "Escape") {
				setOpen(false);
				return;
			}
			onKeyDown(event_0);
		};
		$[24] = onKeyDown;
		$[25] = t12;
	} else t12 = $[25];
	let t13;
	if ($[26] !== listboxId || $[27] !== open || $[28] !== placeholder || $[29] !== query || $[30] !== t12) {
		t13 = /* @__PURE__ */ jsxs("div", {
			ref: setShellElement,
			className: "flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-transparent bg-transparent px-0 focus-within:border-input focus-within:px-1.5",
			children: [t9, /* @__PURE__ */ jsx("input", {
				className: "h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/55",
				value: query,
				placeholder,
				role: "combobox",
				"aria-label": "Search block reference",
				"aria-expanded": open,
				"aria-controls": listboxId,
				"aria-autocomplete": "list",
				onFocus: t10,
				onChange: t11,
				onKeyDown: t12
			})]
		});
		$[26] = listboxId;
		$[27] = open;
		$[28] = placeholder;
		$[29] = query;
		$[30] = t12;
		$[31] = t13;
	} else t13 = $[31];
	let t14;
	if ($[32] !== activeIndex || $[33] !== candidates || $[34] !== getOptionProps || $[35] !== loading || $[36] !== selectionMode) {
		t14 = candidates.length > 0 ? candidates.map((candidate_1, index_0) => {
			const label = candidateLabel(candidate_1);
			const detail = candidateDetail(candidate_1);
			return /* @__PURE__ */ jsxs("button", {
				type: "button",
				...getOptionProps(index_0),
				className: `flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left ${index_0 === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent hover:text-accent-foreground"}`,
				children: [
					selectionMode === "multiple" && /* @__PURE__ */ jsx(Plus, { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" }),
					/* @__PURE__ */ jsx("span", {
						className: "min-w-0 flex-1 truncate",
						children: label
					}),
					detail && detail !== label && /* @__PURE__ */ jsx("span", {
						className: "max-w-[11rem] truncate text-xs text-muted-foreground",
						children: detail
					})
				]
			}, `${candidate_1.id}:${candidate_1.label}`);
		}) : /* @__PURE__ */ jsx("div", {
			className: "px-2 py-1.5 text-muted-foreground",
			children: loading ? "Searching..." : "No matching blocks"
		});
		$[32] = activeIndex;
		$[33] = candidates;
		$[34] = getOptionProps;
		$[35] = loading;
		$[36] = selectionMode;
		$[37] = t14;
	} else t14 = $[37];
	let t15;
	if ($[38] !== listboxId || $[39] !== open || $[40] !== shellElement || $[41] !== t14) {
		t15 = /* @__PURE__ */ jsx(FloatingListbox, {
			id: listboxId,
			open,
			anchorElement: shellElement,
			maxWidth: 448,
			maxHeight: 256,
			children: t14
		});
		$[38] = listboxId;
		$[39] = open;
		$[40] = shellElement;
		$[41] = t14;
		$[42] = t15;
	} else t15 = $[42];
	let t16;
	if ($[43] !== t13 || $[44] !== t15) {
		t16 = /* @__PURE__ */ jsxs("div", {
			className: "min-w-0",
			onBlur: t8,
			children: [t13, t15]
		});
		$[43] = t13;
		$[44] = t15;
		$[45] = t16;
	} else t16 = $[45];
	return t16;
}
function RefPropertyEditorInner(t0) {
	const $ = c(16);
	const { value, onChange, block, schema } = t0;
	let t1;
	if ($[0] !== value) {
		t1 = normalizeId(value);
		$[0] = value;
		$[1] = t1;
	} else t1 = $[1];
	const blockId = t1;
	const readOnly = block.repo.isReadOnly;
	const t2 = schema;
	let t3;
	if ($[2] !== t2) {
		t3 = targetTypesForSchema(t2);
		$[2] = t2;
		$[3] = t3;
	} else t3 = $[3];
	const targetTypes = t3;
	if (blockId) {
		let t4;
		if ($[4] !== onChange) {
			t4 = () => onChange("");
			$[4] = onChange;
			$[5] = t4;
		} else t4 = $[5];
		let t5;
		if ($[6] !== block || $[7] !== blockId || $[8] !== readOnly || $[9] !== t4) {
			t5 = /* @__PURE__ */ jsx(ReferenceEmbed, {
				owner: block,
				blockId,
				readOnly,
				onRemove: t4
			});
			$[6] = block;
			$[7] = blockId;
			$[8] = readOnly;
			$[9] = t4;
			$[10] = t5;
		} else t5 = $[10];
		return t5;
	}
	if (readOnly) {
		let t4;
		if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
			t4 = /* @__PURE__ */ jsx(EmptyReference, {});
			$[11] = t4;
		} else t4 = $[11];
		return t4;
	}
	let t4;
	if ($[12] !== block || $[13] !== onChange || $[14] !== targetTypes) {
		t4 = /* @__PURE__ */ jsx(ReferenceSearch, {
			owner: block,
			excludeIds: EMPTY_REFS,
			targetTypes,
			placeholder: "Search blocks",
			selectionMode: "single",
			onPick: onChange
		});
		$[12] = block;
		$[13] = onChange;
		$[14] = targetTypes;
		$[15] = t4;
	} else t4 = $[15];
	return t4;
}
function RefListPropertyEditorInner(t0) {
	const $ = c(32);
	const { value, onChange, block, schema } = t0;
	let t1;
	if ($[0] !== value) {
		t1 = normalizeIds(value);
		$[0] = value;
		$[1] = t1;
	} else t1 = $[1];
	const blockIds = t1;
	const readOnly = block.repo.isReadOnly;
	const t2 = schema;
	let t3;
	if ($[2] !== t2) {
		t3 = targetTypesForSchema(t2);
		$[2] = t2;
		$[3] = t3;
	} else t3 = $[3];
	const targetTypes = t3;
	let t4;
	if ($[4] !== blockIds || $[5] !== onChange) {
		t4 = (blockId) => {
			onChange(blockIds.filter((id) => id !== blockId));
		};
		$[4] = blockIds;
		$[5] = onChange;
		$[6] = t4;
	} else t4 = $[6];
	const remove = t4;
	let t5;
	if ($[7] !== blockIds || $[8] !== onChange) {
		t5 = (blockId_0) => {
			const normalized = normalizeId(blockId_0);
			if (!normalized || blockIds.includes(normalized)) return;
			onChange([...blockIds, normalized]);
		};
		$[7] = blockIds;
		$[8] = onChange;
		$[9] = t5;
	} else t5 = $[9];
	const add = t5;
	let t6;
	if ($[10] !== block || $[11] !== blockIds || $[12] !== readOnly || $[13] !== remove) {
		let t7;
		if ($[15] !== block || $[16] !== readOnly || $[17] !== remove) {
			t7 = (blockId_1) => /* @__PURE__ */ jsx(ReferenceEmbed, {
				owner: block,
				blockId: blockId_1,
				readOnly,
				onRemove: () => remove(blockId_1)
			}, blockId_1);
			$[15] = block;
			$[16] = readOnly;
			$[17] = remove;
			$[18] = t7;
		} else t7 = $[18];
		t6 = blockIds.map(t7);
		$[10] = block;
		$[11] = blockIds;
		$[12] = readOnly;
		$[13] = remove;
		$[14] = t6;
	} else t6 = $[14];
	let t7;
	if ($[19] !== add || $[20] !== block || $[21] !== blockIds || $[22] !== readOnly || $[23] !== targetTypes) {
		t7 = !readOnly && /* @__PURE__ */ jsx(ReferenceSearch, {
			owner: block,
			excludeIds: blockIds,
			targetTypes,
			placeholder: blockIds.length > 0 ? "Add block" : "Search blocks",
			selectionMode: "multiple",
			onPick: add
		});
		$[19] = add;
		$[20] = block;
		$[21] = blockIds;
		$[22] = readOnly;
		$[23] = targetTypes;
		$[24] = t7;
	} else t7 = $[24];
	let t8;
	if ($[25] !== blockIds.length || $[26] !== readOnly) {
		t8 = readOnly && blockIds.length === 0 && /* @__PURE__ */ jsx(EmptyReference, {});
		$[25] = blockIds.length;
		$[26] = readOnly;
		$[27] = t8;
	} else t8 = $[27];
	let t9;
	if ($[28] !== t6 || $[29] !== t7 || $[30] !== t8) {
		t9 = /* @__PURE__ */ jsxs("div", {
			className: "min-w-0 space-y-1.5",
			children: [
				t6,
				t7,
				t8
			]
		});
		$[28] = t6;
		$[29] = t7;
		$[30] = t8;
		$[31] = t9;
	} else t9 = $[31];
	return t9;
}
function RefPropertyEditor(props) {
	const $ = c(3);
	if (!(props.block instanceof Block)) {
		let t0;
		if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
			t0 = /* @__PURE__ */ jsx(EmptyReference, {});
			$[0] = t0;
		} else t0 = $[0];
		return t0;
	}
	let t0;
	if ($[1] !== props) {
		t0 = /* @__PURE__ */ jsx(RefPropertyEditorInner, {
			...props,
			block: props.block
		});
		$[1] = props;
		$[2] = t0;
	} else t0 = $[2];
	return t0;
}
function RefListPropertyEditor(props) {
	const $ = c(3);
	if (!(props.block instanceof Block)) {
		let t0;
		if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
			t0 = /* @__PURE__ */ jsx(EmptyReference, {});
			$[0] = t0;
		} else t0 = $[0];
		return t0;
	}
	let t0;
	if ($[1] !== props) {
		t0 = /* @__PURE__ */ jsx(RefListPropertyEditorInner, {
			...props,
			block: props.block
		});
		$[1] = props;
		$[2] = t0;
	} else t0 = $[2];
	return t0;
}
//#endregion
export { RefListPropertyEditor, RefPropertyEditor, ReferenceSearch };

//# sourceMappingURL=RefPropertyEditor.js.map