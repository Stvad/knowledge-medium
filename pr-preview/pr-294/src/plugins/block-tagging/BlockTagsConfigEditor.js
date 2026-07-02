import { isReadOnlyBlock } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { Input } from "../../components/ui/input.js";
import { Button } from "../../components/ui/button.js";
import { Plus } from "../../../node_modules/lucide-react/dist/esm/icons/plus.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { isValidTagName, normalizeBlockTagsConfig } from "./config.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/block-tagging/BlockTagsConfigEditor.tsx
var BlockTagsConfigEditor = (t0) => {
	const $ = c(33);
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
		t2 = normalizeBlockTagsConfig(value);
		$[2] = value;
		$[3] = t2;
	} else t2 = $[3];
	const tags = t2;
	const [draft, setDraft] = useState("");
	let t3;
	if ($[4] !== draft || $[5] !== onChange || $[6] !== tags) {
		t3 = () => {
			const trimmed = draft.trim();
			if (!isValidTagName(trimmed) || tags.includes(trimmed)) return;
			onChange(normalizeBlockTagsConfig([...tags, trimmed]));
			setDraft("");
		};
		$[4] = draft;
		$[5] = onChange;
		$[6] = tags;
		$[7] = t3;
	} else t3 = $[7];
	const commitDraft = t3;
	let t4;
	if ($[8] !== draft) {
		t4 = draft.trim().length > 0 && !isValidTagName(draft);
		$[8] = draft;
		$[9] = t4;
	} else t4 = $[9];
	const draftInvalid = t4;
	let t5;
	if ($[10] !== commitDraft) {
		t5 = (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				commitDraft();
			}
		};
		$[10] = commitDraft;
		$[11] = t5;
	} else t5 = $[11];
	const handleKeyDown = t5;
	let t6;
	if ($[12] !== onChange || $[13] !== tags) {
		t6 = (tag) => {
			onChange(normalizeBlockTagsConfig(tags.filter((t) => t !== tag)));
		};
		$[12] = onChange;
		$[13] = tags;
		$[14] = t6;
	} else t6 = $[14];
	const removeTag = t6;
	let t7;
	if ($[15] !== readOnly || $[16] !== removeTag || $[17] !== tags) {
		let t8;
		if ($[19] !== readOnly || $[20] !== removeTag) {
			t8 = (tag_0) => /* @__PURE__ */ jsxs("span", {
				className: "inline-flex min-w-0 items-center gap-1 rounded-sm border border-border/60 bg-muted/40 px-1.5 py-0.5 text-xs",
				title: tag_0,
				children: [/* @__PURE__ */ jsxs("span", {
					className: "max-w-[18ch] truncate",
					children: [
						"[[",
						tag_0,
						"]]"
					]
				}), !readOnly && /* @__PURE__ */ jsx("button", {
					type: "button",
					onClick: () => removeTag(tag_0),
					className: "shrink-0 rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
					"aria-label": `Remove ${tag_0}`,
					children: /* @__PURE__ */ jsx(X, { className: "h-3 w-3" })
				})]
			}, tag_0);
			$[19] = readOnly;
			$[20] = removeTag;
			$[21] = t8;
		} else t8 = $[21];
		t7 = tags.map(t8);
		$[15] = readOnly;
		$[16] = removeTag;
		$[17] = tags;
		$[18] = t7;
	} else t7 = $[18];
	let t8;
	if ($[22] !== t7) {
		t8 = /* @__PURE__ */ jsx("div", {
			className: "flex flex-wrap items-center gap-1",
			children: t7
		});
		$[22] = t7;
		$[23] = t8;
	} else t8 = $[23];
	let t9;
	if ($[24] !== commitDraft || $[25] !== draft || $[26] !== draftInvalid || $[27] !== handleKeyDown || $[28] !== readOnly) {
		t9 = !readOnly && /* @__PURE__ */ jsxs(Fragment$1, { children: [/* @__PURE__ */ jsxs("div", {
			className: "flex items-center gap-1",
			children: [/* @__PURE__ */ jsx(Input, {
				value: draft,
				placeholder: "Add tag",
				onChange: (event_0) => setDraft(event_0.target.value),
				onKeyDown: handleKeyDown,
				onBlur: commitDraft
			}), /* @__PURE__ */ jsx(Button, {
				type: "button",
				variant: "ghost",
				size: "icon",
				onClick: commitDraft,
				disabled: !isValidTagName(draft),
				title: "Add tag",
				children: /* @__PURE__ */ jsx(Plus, { className: "h-4 w-4" })
			})]
		}), draftInvalid && /* @__PURE__ */ jsxs("p", {
			className: "text-xs text-destructive",
			children: [
				"Tag names can't contain ",
				/* @__PURE__ */ jsx("code", { children: "[[" }),
				" or ",
				/* @__PURE__ */ jsx("code", { children: "]]" }),
				"."
			]
		})] });
		$[24] = commitDraft;
		$[25] = draft;
		$[26] = draftInvalid;
		$[27] = handleKeyDown;
		$[28] = readOnly;
		$[29] = t9;
	} else t9 = $[29];
	let t10;
	if ($[30] !== t8 || $[31] !== t9) {
		t10 = /* @__PURE__ */ jsxs("div", {
			className: "space-y-2",
			children: [t8, t9]
		});
		$[30] = t8;
		$[31] = t9;
		$[32] = t10;
	} else t10 = $[32];
	return t10;
};
//#endregion
export { BlockTagsConfigEditor };

//# sourceMappingURL=BlockTagsConfigEditor.js.map