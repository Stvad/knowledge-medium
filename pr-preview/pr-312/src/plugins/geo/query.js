import { defineQuery } from "../../data/api/query.js";
import { object, string } from "../../../node_modules/zod/v4/classic/schemas.js";
import "../../data/api/index.js";
import { typesProp } from "../../data/properties.js";
import { locationProp, placeAddressProp, placeLatProp, placeLngProp } from "./properties.js";
import "./blockTypes.js";
//#region src/plugins/geo/query.ts
/** Queries for the geo plugin.
*
*  `placesUnderBlock` — drives the map view. Given a root block id,
*  returns one pin per "block → Place" pairing found in the subtree:
*    - Place blocks (PLACE_TYPE) pin at their own lat/lng — so a map
*      rooted at the Locations page shows every Place.
*    - Non-Place blocks with `location` set pin at their referenced
*      Place's lat/lng — so a map rooted at a trip block shows every
*      activity that has a location.
*    - Non-Place blocks whose body content references a Place via a
*      wikilink or block-ref (`[[Dandelion]]`, `((uuid))`) pin at
*      that Place's lat/lng — so a casual mention of a place in a note
*      surfaces on the map without having to set the `location` prop.
*      Only body refs (`sourceField === ''`) participate; refs
*      projected from typed properties go through their own path.
*
*  A block that mentions the same place via both its `location` prop
*  and a body wikilink yields one pin (dedupped by target Place id).
*
*  Dependencies are declared per-row (catches descendant content,
*  property, and reference changes) + per-referenced-Place so the
*  query re-resolves whenever a descendant changes, a referenced Place
*  moves, or a block's `location` / body refs change. */
var PLACES_UNDER_BLOCK_QUERY = "geo.placesUnderBlock";
var pinArraySchema = { parse: (input) => input };
var isPlace = (block) => {
	const raw = block.properties[typesProp.name];
	return Array.isArray(raw) && raw.includes("place");
};
var numProp = (block, name) => {
	const raw = block.properties[name];
	return typeof raw === "number" ? raw : void 0;
};
var refProp = (block, name) => {
	const raw = block.properties[name];
	return typeof raw === "string" ? raw : void 0;
};
var strProp = (block, name) => {
	const raw = block.properties[name];
	return typeof raw === "string" ? raw : void 0;
};
var pinFromPlace = (source, place) => {
	const lat = numProp(place, placeLatProp.name);
	const lng = numProp(place, placeLngProp.name);
	if (lat === void 0 || lng === void 0) return null;
	return {
		blockId: source.id,
		placeId: place.id,
		name: place.content,
		lat,
		lng,
		address: strProp(place, placeAddressProp.name)
	};
};
var placesUnderBlockQuery = defineQuery({
	name: PLACES_UNDER_BLOCK_QUERY,
	argsSchema: object({ rootBlockId: string() }),
	resultSchema: pinArraySchema,
	resolve: async ({ rootBlockId }, ctx) => {
		if (!rootBlockId) return [];
		const blocks = await ctx.run("core.subtree", { id: rootBlockId });
		const placeCache = /* @__PURE__ */ new Map();
		const loadPlace = async (id) => {
			if (placeCache.has(id)) return placeCache.get(id) ?? null;
			ctx.depend({
				kind: "row",
				id
			});
			const place = await ctx.repo.block(id).load();
			placeCache.set(id, place);
			return place;
		};
		const pins = [];
		for (const block of blocks) {
			if (isPlace(block)) {
				const pin = pinFromPlace(block, block);
				if (pin) pins.push(pin);
				continue;
			}
			const seen = /* @__PURE__ */ new Set();
			const tryPin = async (targetId) => {
				if (seen.has(targetId)) return;
				const place = await loadPlace(targetId);
				if (!place || place.deleted || !isPlace(place)) return;
				const pin = pinFromPlace(block, place);
				if (!pin) return;
				pins.push(pin);
				seen.add(targetId);
			};
			const locationRef = refProp(block, locationProp.name);
			if (locationRef !== void 0) await tryPin(locationRef);
			for (const ref of block.references) {
				if (ref.sourceField !== void 0 && ref.sourceField !== "") continue;
				await tryPin(ref.id);
			}
		}
		return pins;
	}
});
//#endregion
export { PLACES_UNDER_BLOCK_QUERY, placesUnderBlockQuery };

//# sourceMappingURL=query.js.map