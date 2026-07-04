import { explodePageTokens, normalizeRoamPropertyValue } from "./properties.js";
import { stripRoamTodoContent } from "./todo.js";
import { stripSrsScheduleMetadataFromValue } from "./srsMarkers.js";
//#region src/plugins/roam-import/promotion.ts
var INLINE_ATTR_RE = /^([^:\n]{1,100})::\s*(.*)$/;
var INLINE_ATTR_KEY_RE = /^[\p{L}][\p{L}\p{N} _%?'’().,;/-]*$/u;
var PAGE_REF_ATTR_KEY_RE = /^\[\[[^\n]+\]\]$/;
var isInlineAttrKey = (key) => INLINE_ATTR_KEY_RE.test(key) || PAGE_REF_ATTR_KEY_RE.test(key);
var detectInlineAttribute = (rawContent) => {
	if (!rawContent) return null;
	const content = stripRoamTodoContent(rawContent);
	if (content.includes("\n")) return null;
	const match = INLINE_ATTR_RE.exec(content);
	if (!match) return null;
	const key = match[1].trim();
	if (!isInlineAttrKey(key)) return null;
	return {
		key,
		value: stripSrsScheduleMetadataFromValue(match[2])
	};
};
/** Walk a parent's direct children and compute case-1/2/3/4 promotion.
*  No tree edits: every source block survives as a descendant of its
*  original parent. The promotion is purely additive.
*
*  `alreadyBubbled` is a set of uids whose values were already pulled
*  up by an ancestor's promotion pass. Without it, an intermediate
*  kept attr block (along an `attr -> attr` chain) would re-bubble the
*  same descendants onto itself when buildBlock recurses into it. */
var computePromotedFromChildren = (children, alreadyBubbled, options = {}) => {
	const accumulator = /* @__PURE__ */ new Map();
	const diagnostics = [];
	const newlyBubbled = /* @__PURE__ */ new Set();
	const namespacePrefix = options.namespacePrefix ?? "roam";
	const transformKey = options.transformKey ?? ((key) => key);
	const push = (key, value) => {
		const propName = `${namespacePrefix}:${transformKey(key)}`;
		const list = accumulator.get(propName) ?? [];
		list.push(typeof value === "string" ? normalizeRoamPropertyValue(value) : value);
		accumulator.set(propName, list);
	};
	const consume = (block, depth) => {
		if (alreadyBubbled.has(block.uid) || newlyBubbled.has(block.uid)) return;
		const attr = detectInlineAttribute(block.string);
		if (!attr) return;
		if (depth >= 2) diagnostics.push(`Attribute "${attr.key}" hoisted from depth ${depth + 1} (uid ${block.uid}) — unusual nesting; review the source structure.`);
		newlyBubbled.add(block.uid);
		if (attr.value.trim() !== "") push(attr.key, attr.value);
		for (const sub of block.children ?? []) if (detectInlineAttribute(sub.string)) consume(sub, depth + 1);
		else push(attr.key, stripRoamTodoContent(sub.string));
	};
	for (const child of children) consume(child, 0);
	const promoted = {};
	for (const [key, values] of accumulator) if (values.length === 1) {
		const single = values[0];
		if (typeof single === "string") promoted[key] = explodePageTokens(single) ?? single;
		else promoted[key] = single;
	} else {
		const flat = [];
		for (const v of values) if (typeof v === "string") {
			const exploded = explodePageTokens(v);
			if (exploded) flat.push(...exploded);
			else flat.push(v);
		} else flat.push(v);
		promoted[key] = flat;
	}
	return {
		promoted,
		diagnostics,
		bubbled: newlyBubbled
	};
};
//#endregion
export { computePromotedFromChildren, detectInlineAttribute };

//# sourceMappingURL=promotion.js.map