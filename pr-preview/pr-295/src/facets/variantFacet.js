import { defineFacet, isFunction } from "./facet.js";
//#region src/facets/variantFacet.ts
var EMPTY_VARIANTS = [];
var emptySelection = () => ({
	all: EMPTY_VARIANTS,
	last: void 0,
	first: void 0,
	byId: () => void 0
});
/**
* Define a facet whose contributions register named alternatives
* (variants) for a slot. The resolved value enumerates the registered
* variants and offers convenience pickers (`last`, `first`, `byId`);
* the consumer decides which one to render — typically by reading a
* user preference reactively at render time.
*
* Why selection lives in the consumer: most useful selections want to
* react to a property/preference change (re-render when the user picks
* a different variant). The facet's `combine` runs once per facet read
* and is cached, so embedding selection here would either freeze the
* choice or force every reactive prop to be threaded through
* `BlockResolveContext` — defeating the resolver-context stability
* split (see `BlockResolveContext` doc).
*/
function defineVariantFacet({ id }) {
	return defineFacet({
		id,
		combine: (contributions) => (context) => {
			const all = [];
			for (const contribution of contributions) {
				const variant = contribution(context);
				if (variant) all.push(variant);
			}
			if (all.length === 0) return emptySelection();
			const byIdMap = /* @__PURE__ */ new Map();
			for (const variant of all) byIdMap.set(variant.id, variant);
			return {
				all,
				first: all[0],
				last: all[all.length - 1],
				byId: (lookup) => lookup == null ? void 0 : byIdMap.get(lookup)
			};
		},
		empty: () => () => emptySelection(),
		validate: isFunction
	});
}
/**
* Construct a Variant in a single expression. Sugar for plugins that
* register a single variant inline (e.g. `defineVariant('flat',
* 'Flat', LinkedReferences)` reads more naturally than building the
* object literal). Functionally identical to `{id, label, render}`.
*/
var defineVariant = (id, label, render) => ({
	id,
	label,
	render
});
//#endregion
export { defineVariant, defineVariantFacet };

//# sourceMappingURL=variantFacet.js.map