import { charLimitProp } from "./properties.js";
import "./blockType.js";
import { useContent, useProperty } from "../../hooks/block.js";
import { charCountDisplay } from "./charCount.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/character-counter/CharacterCountDecorator.tsx
var CharacterCountDecorator = (t0) => {
	const $ = c(12);
	const { block, Inner } = t0;
	const content = useContent(block);
	const [limit] = useProperty(block, charLimitProp);
	let t1;
	if ($[0] !== content.length || $[1] !== limit) {
		t1 = charCountDisplay(content.length, limit);
		$[0] = content.length;
		$[1] = limit;
		$[2] = t1;
	} else t1 = $[2];
	const { text, over } = t1;
	let t2;
	if ($[3] !== Inner || $[4] !== block) {
		t2 = /* @__PURE__ */ jsx(Inner, { block });
		$[3] = Inner;
		$[4] = block;
		$[5] = t2;
	} else t2 = $[5];
	const t3 = `pointer-events-none absolute bottom-0 right-0 select-none text-xs tabular-nums ${over ? "text-destructive" : "text-muted-foreground"}`;
	let t4;
	if ($[6] !== t3 || $[7] !== text) {
		t4 = /* @__PURE__ */ jsx("span", {
			className: t3,
			"aria-label": "Character count",
			children: text
		});
		$[6] = t3;
		$[7] = text;
		$[8] = t4;
	} else t4 = $[8];
	let t5;
	if ($[9] !== t2 || $[10] !== t4) {
		t5 = /* @__PURE__ */ jsxs("div", {
			className: "relative w-full",
			children: [t2, t4]
		});
		$[9] = t2;
		$[10] = t4;
		$[11] = t5;
	} else t5 = $[11];
	return t5;
};
var cache = /* @__PURE__ */ new WeakMap();
var decorate = (inner) => {
	const existing = cache.get(inner);
	if (existing) return existing;
	const Decorated = (t0) => {
		const $ = c(2);
		const { block } = t0;
		let t1;
		if ($[0] !== block) {
			t1 = /* @__PURE__ */ jsx(CharacterCountDecorator, {
				block,
				Inner: inner
			});
			$[0] = block;
			$[1] = t1;
		} else t1 = $[1];
		return t1;
	};
	Decorated.displayName = "WithCharacterCount";
	cache.set(inner, Decorated);
	return Decorated;
};
var characterCountDecoratorContribution = (ctx) => ctx.types.includes("char-counter") ? decorate : null;
//#endregion
export { characterCountDecoratorContribution };

//# sourceMappingURL=CharacterCountDecorator.js.map