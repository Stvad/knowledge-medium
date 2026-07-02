import { Input } from "../../components/ui/input.js";
import { Button } from "../../components/ui/button.js";
import { usePluginPrefsProperty } from "../../data/globalState.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { blockTaggingPrefsType, blockTagsConfigProp, isValidTagName, normalizeBlockTagsConfig } from "./config.js";
import { useEffect, useRef, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/block-tagging/AddTagDialog.tsx
var filterTags = (tags, query) => {
	const trimmed = query.trim().toLowerCase();
	if (!trimmed) return [...tags];
	return tags.filter((tag) => tag.toLowerCase().includes(trimmed));
};
var AddTagDialog = (t0) => {
	const $ = c(51);
	const { resolve, cancel } = t0;
	const [storedTags] = usePluginPrefsProperty(blockTaggingPrefsType, blockTagsConfigProp);
	let t1;
	if ($[0] !== storedTags) {
		t1 = normalizeBlockTagsConfig(storedTags);
		$[0] = storedTags;
		$[1] = t1;
	} else t1 = $[1];
	const tags = t1;
	const [query, setQuery] = useState("");
	let t2;
	if ($[2] !== query || $[3] !== tags) {
		t2 = filterTags(tags, query);
		$[2] = query;
		$[3] = tags;
		$[4] = t2;
	} else t2 = $[4];
	const filteredTags = t2;
	const inputRef = useRef(null);
	let t3;
	let t4;
	if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = () => {
			inputRef.current?.focus();
		};
		t4 = [];
		$[5] = t3;
		$[6] = t4;
	} else {
		t3 = $[5];
		t4 = $[6];
	}
	useEffect(t3, t4);
	let exactQueryMatch;
	let t5;
	let trimmedQuery;
	if ($[7] !== query || $[8] !== tags) {
		trimmedQuery = query.trim();
		exactQueryMatch = trimmedQuery.length > 0 && tags.some((tag) => tag.toLowerCase() === trimmedQuery.toLowerCase());
		t5 = trimmedQuery.length > 0 && !isValidTagName(trimmedQuery);
		$[7] = query;
		$[8] = tags;
		$[9] = exactQueryMatch;
		$[10] = t5;
		$[11] = trimmedQuery;
	} else {
		exactQueryMatch = $[9];
		t5 = $[10];
		trimmedQuery = $[11];
	}
	const queryInvalid = t5;
	const canCreateCustom = trimmedQuery.length > 0 && !exactQueryMatch && !queryInvalid;
	let t6;
	if ($[12] !== resolve) {
		t6 = (tagName) => {
			const next = tagName.trim();
			if (!isValidTagName(next)) return;
			resolve({ tagName: next });
		};
		$[12] = resolve;
		$[13] = t6;
	} else t6 = $[13];
	const submitTag = t6;
	let t7;
	if ($[14] !== cancel) {
		t7 = (next_0) => {
			if (!next_0) cancel();
		};
		$[14] = cancel;
		$[15] = t7;
	} else t7 = $[15];
	let t8;
	if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
		t8 = /* @__PURE__ */ jsx(DialogHeader, { children: /* @__PURE__ */ jsx(DialogTitle, { children: "Add tag" }) });
		$[16] = t8;
	} else t8 = $[16];
	let t9;
	if ($[17] !== canCreateCustom || $[18] !== filteredTags[0] || $[19] !== filteredTags.length || $[20] !== submitTag || $[21] !== trimmedQuery) {
		t9 = (event) => {
			event.preventDefault();
			if (filteredTags.length > 0) {
				submitTag(filteredTags[0]);
				return;
			}
			if (canCreateCustom) submitTag(trimmedQuery);
		};
		$[17] = canCreateCustom;
		$[18] = filteredTags[0];
		$[19] = filteredTags.length;
		$[20] = submitTag;
		$[21] = trimmedQuery;
		$[22] = t9;
	} else t9 = $[22];
	const t10 = tags.length > 0 ? "Search or type a new tag" : "Type a tag name";
	let t11;
	if ($[23] === Symbol.for("react.memo_cache_sentinel")) {
		t11 = (event_0) => setQuery(event_0.target.value);
		$[23] = t11;
	} else t11 = $[23];
	let t12;
	if ($[24] !== query || $[25] !== t10) {
		t12 = /* @__PURE__ */ jsx(Input, {
			ref: inputRef,
			value: query,
			placeholder: t10,
			onChange: t11
		});
		$[24] = query;
		$[25] = t10;
		$[26] = t12;
	} else t12 = $[26];
	let t13;
	if ($[27] !== tags.length) {
		t13 = tags.length === 0 && /* @__PURE__ */ jsx("p", {
			className: "text-xs text-muted-foreground",
			children: "No tags configured yet. Type a name to apply it once, or add defaults under the user-prefs \"Block tags\" entry."
		});
		$[27] = tags.length;
		$[28] = t13;
	} else t13 = $[28];
	let t14;
	if ($[29] !== queryInvalid) {
		t14 = queryInvalid && /* @__PURE__ */ jsxs("p", {
			className: "text-xs text-destructive",
			children: [
				"Tag names can't contain ",
				/* @__PURE__ */ jsx("code", { children: "[[" }),
				" or ",
				/* @__PURE__ */ jsx("code", { children: "]]" }),
				"."
			]
		});
		$[29] = queryInvalid;
		$[30] = t14;
	} else t14 = $[30];
	let t15;
	if ($[31] !== filteredTags || $[32] !== submitTag) {
		t15 = filteredTags.length > 0 && /* @__PURE__ */ jsx("ul", {
			className: "flex flex-col gap-1",
			children: filteredTags.map((tag_0) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsx("button", {
				type: "button",
				className: "flex w-full items-center justify-between rounded-sm border border-border/60 px-2 py-1 text-left text-sm hover:bg-accent",
				onClick: () => submitTag(tag_0),
				children: /* @__PURE__ */ jsxs("span", {
					className: "truncate",
					children: [
						"[[",
						tag_0,
						"]]"
					]
				})
			}) }, tag_0))
		});
		$[31] = filteredTags;
		$[32] = submitTag;
		$[33] = t15;
	} else t15 = $[33];
	let t16;
	if ($[34] !== canCreateCustom || $[35] !== submitTag || $[36] !== trimmedQuery) {
		t16 = canCreateCustom && /* @__PURE__ */ jsx("button", {
			type: "button",
			className: "flex w-full items-center justify-between rounded-sm border border-dashed border-border px-2 py-1 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
			onClick: () => submitTag(trimmedQuery),
			children: /* @__PURE__ */ jsxs("span", {
				className: "truncate",
				children: [
					"Apply [[",
					trimmedQuery,
					"]] (one-off)"
				]
			})
		});
		$[34] = canCreateCustom;
		$[35] = submitTag;
		$[36] = trimmedQuery;
		$[37] = t16;
	} else t16 = $[37];
	let t17;
	if ($[38] !== cancel) {
		t17 = /* @__PURE__ */ jsx(DialogFooter, {
			className: "pt-1",
			children: /* @__PURE__ */ jsx(Button, {
				type: "button",
				variant: "ghost",
				onClick: cancel,
				children: "Cancel"
			})
		});
		$[38] = cancel;
		$[39] = t17;
	} else t17 = $[39];
	let t18;
	if ($[40] !== t12 || $[41] !== t13 || $[42] !== t14 || $[43] !== t15 || $[44] !== t16 || $[45] !== t17 || $[46] !== t9) {
		t18 = /* @__PURE__ */ jsxs(DialogContent, {
			className: "max-w-sm",
			children: [t8, /* @__PURE__ */ jsxs("form", {
				className: "space-y-3",
				onSubmit: t9,
				children: [
					t12,
					t13,
					t14,
					t15,
					t16,
					t17
				]
			})]
		});
		$[40] = t12;
		$[41] = t13;
		$[42] = t14;
		$[43] = t15;
		$[44] = t16;
		$[45] = t17;
		$[46] = t9;
		$[47] = t18;
	} else t18 = $[47];
	let t19;
	if ($[48] !== t18 || $[49] !== t7) {
		t19 = /* @__PURE__ */ jsx(Dialog, {
			open: true,
			onOpenChange: t7,
			children: t18
		});
		$[48] = t18;
		$[49] = t7;
		$[50] = t19;
	} else t19 = $[50];
	return t19;
};
//#endregion
export { AddTagDialog };

//# sourceMappingURL=AddTagDialog.js.map