import { typesProp } from "../../data/properties.js";
import { cn } from "../../lib/utils.js";
import { useProperty } from "../../hooks/block.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { visibleTagTypeIds } from "./typeAutocomplete.js";
import { useTypes } from "../../hooks/typeRegistry.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/supertags/TypeChipsDecorator.tsx
/** Block content decorator that renders a block's types as trailing
*  `#label` chips (Tana-style supertags), each with a remove button.
*
*  Unlike the character-counter/geo decorators, the contribution does
*  NOT gate on `ctx.types` — the wrap applies to every block and the
*  component decides whether to render chips. NOTE the honest scope of
*  this: a types change still remounts the content subtree regardless,
*  because `types` participates in `DefaultBlockRenderer`'s
*  resolve-context and slot identity (the `#` pick flow stays correct
*  across that remount because its tag write is cache-coherent — see
*  codeMirrorExtensions.ts). What the unconditional wrap DOES buy:
*  chip visibility driven by the registry (`hideTag` edits, late type
*  publication) re-renders in place instead of re-resolving decorator
*  gates, and if the renderer's slot identity is ever stabilized the
*  no-remount invariant holds here without changes. The WeakMap cache
*  keeps identity stable across parent re-renders (same invariant as
*  CharacterCountDecorator). */
/** Contribution-declared chip color, validated so an unparseable value
*  degrades to default styling instead of a half-styled chip. (Inline
*  styles assign via CSSOM, so invalid values can't inject — this is
*  purely a rendering-quality guard.) */
var chipColor = (type) => {
	const color = type?.color?.trim();
	if (!color) return void 0;
	if (typeof CSS !== "undefined" && CSS.supports && !CSS.supports("color", color)) return void 0;
	return color;
};
var TypeChips = (t0) => {
	const $ = c(11);
	const { block, typeIds, registry } = t0;
	const readOnly = block.repo.isReadOnly;
	let t1;
	if ($[0] !== block || $[1] !== readOnly || $[2] !== registry || $[3] !== typeIds) {
		let t2;
		if ($[5] !== block || $[6] !== readOnly || $[7] !== registry) {
			t2 = (typeId) => {
				const type = registry.get(typeId);
				const label = type?.label ?? (typeId.length > 8 ? `${typeId.slice(0, 8)}…` : typeId);
				const color = chipColor(type);
				return /* @__PURE__ */ jsxs("span", {
					className: cn("inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-xs", color ? "" : "bg-muted text-muted-foreground"),
					style: color ? {
						color,
						backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`
					} : void 0,
					title: type ? type.description ?? typeId : `Unknown type ${typeId} (not registered)`,
					children: [/* @__PURE__ */ jsxs("span", {
						className: "truncate",
						children: ["#", label]
					}), !readOnly && /* @__PURE__ */ jsx("button", {
						type: "button",
						className: cn("rounded-sm p-1 -m-1 hover:bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", color ? "text-inherit opacity-70 hover:opacity-100" : "text-muted-foreground hover:text-foreground"),
						"aria-label": `Remove ${label} type`,
						onMouseDown: _temp,
						onClick: (event_0) => {
							event_0.stopPropagation();
							block.removeType(typeId);
						},
						children: /* @__PURE__ */ jsx(X, { className: "h-3 w-3" })
					})]
				}, typeId);
			};
			$[5] = block;
			$[6] = readOnly;
			$[7] = registry;
			$[8] = t2;
		} else t2 = $[8];
		t1 = typeIds.map(t2);
		$[0] = block;
		$[1] = readOnly;
		$[2] = registry;
		$[3] = typeIds;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[9] !== t1) {
		t2 = /* @__PURE__ */ jsx("span", {
			className: "flex shrink-0 flex-wrap items-center gap-1",
			"aria-label": "Block types",
			children: t1
		});
		$[9] = t1;
		$[10] = t2;
	} else t2 = $[10];
	return t2;
};
var TypeChipsDecorator = (t0) => {
	const $ = c(13);
	const { block, Inner } = t0;
	const [types] = useProperty(block, typesProp);
	const registry = useTypes();
	let t1;
	if ($[0] !== registry || $[1] !== types) {
		t1 = visibleTagTypeIds(types, registry);
		$[0] = registry;
		$[1] = types;
		$[2] = t1;
	} else t1 = $[2];
	const visible = t1;
	let t2;
	if ($[3] !== Inner || $[4] !== block) {
		t2 = /* @__PURE__ */ jsx("div", {
			className: "min-w-0 max-w-full flex-1 basis-48",
			children: /* @__PURE__ */ jsx(Inner, { block })
		});
		$[3] = Inner;
		$[4] = block;
		$[5] = t2;
	} else t2 = $[5];
	let t3;
	if ($[6] !== block || $[7] !== registry || $[8] !== visible) {
		t3 = visible.length > 0 && /* @__PURE__ */ jsx(TypeChips, {
			block,
			typeIds: visible,
			registry
		});
		$[6] = block;
		$[7] = registry;
		$[8] = visible;
		$[9] = t3;
	} else t3 = $[9];
	let t4;
	if ($[10] !== t2 || $[11] !== t3) {
		t4 = /* @__PURE__ */ jsxs("div", {
			className: "flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5",
			children: [t2, t3]
		});
		$[10] = t2;
		$[11] = t3;
		$[12] = t4;
	} else t4 = $[12];
	return t4;
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
			t1 = /* @__PURE__ */ jsx(TypeChipsDecorator, {
				block,
				Inner: inner
			});
			$[0] = block;
			$[1] = t1;
		} else t1 = $[1];
		return t1;
	};
	Decorated.displayName = "WithTypeChips";
	cache.set(inner, Decorated);
	return Decorated;
};
var typeChipsDecoratorContribution = () => decorate;
function _temp(event) {
	return event.preventDefault();
}
//#endregion
export { typeChipsDecoratorContribution };

//# sourceMappingURL=TypeChipsDecorator.js.map