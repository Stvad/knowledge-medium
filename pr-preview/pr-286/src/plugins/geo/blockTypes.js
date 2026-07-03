import { defineBlockType } from "../../data/api/blockType.js";
import "../../data/api/index.js";
import { aliasesProp } from "../../data/properties.js";
import { PLACE_PROPERTY_SCHEMAS } from "./properties.js";
//#region src/plugins/geo/blockTypes.ts
/** Geo-plugin block types. `PLACE_TYPE` blocks hold a single physical-
*  world location (Google POI or ad-hoc coord pin). `MAP_TYPE` is a
*  generic, user-applicable tag: any block carrying it gets a map of
*  the places under it via `geoContentDecorator`. The Locations page
*  ships with this type, but it is not special — the same tag added
*  to a trip page, an event, or any other block produces an inline
*  map rooted at that block.
*
*  Type id strings must match `PLACE_TYPE_ID` in `./properties.ts` —
*  duplicated as a literal there to break the import cycle. */
var PLACE_TYPE = "place";
var MAP_TYPE = "map";
var GEO_TYPE_CONTRIBUTIONS = [defineBlockType({
	id: PLACE_TYPE,
	label: "Place",
	description: "A physical-world location — Google POI or an ad-hoc coordinate pin.",
	properties: [...PLACE_PROPERTY_SCHEMAS]
}), defineBlockType({
	id: "map",
	label: "Map",
	description: "Renders an inline map of the places under this block (Places themselves, or any block with a `location` ref).",
	properties: [aliasesProp]
})];
//#endregion
export { GEO_TYPE_CONTRIBUTIONS, MAP_TYPE, PLACE_TYPE };

//# sourceMappingURL=blockTypes.js.map