import { ChangeScope } from "../../data/api/changeScope.js";
import { codecs } from "../../data/api/codecs.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { optionalRefCodec } from "./codecs.js";
//#region src/plugins/geo/properties.ts
/** Geo-plugin property schemas. All `place:*` fields live on Place
*  blocks (Google POIs and ad-hoc coordinate pins alike); `location` is
*  the typed reference property that any block can set to point at a
*  Place.
*
*  Storage rationale:
*    - `lat` / `lng` are stored as scalar numbers, not a `{lat, lng}`
*      blob. The `where` capability lives on primitive codecs only;
*      keeping coords scalar lets the map-view query stay on the typed-
*      query path instead of synthesising a json_extract clause.
*    - `googlePlaceId` and `googleMapsUrl` are both optional. Google POIs
*      created via the `@` autocomplete have the `ChIJ…` id; Roam
*      imports carry only the legacy `?cid=…` URL; ad-hoc pins have
*      neither.
*    - `categories` mirrors Google's `types[]` and Roam's `isa`. List of
*      strings for v1; promote to references to Category blocks if/when
*      a category tree is wanted.
*/
var PLACE_TYPE_ID = "place";
var placeLatProp = defineProperty("place:lat", {
	codec: codecs.optionalNumber,
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
var placeLngProp = defineProperty("place:lng", {
	codec: codecs.optionalNumber,
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
var placeAddressProp = defineProperty("place:address", {
	codec: codecs.optionalString,
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
var placeGooglePlaceIdProp = defineProperty("place:googlePlaceId", {
	codec: codecs.optionalString,
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
var placeGoogleMapsUrlProp = defineProperty("place:googleMapsUrl", {
	codec: codecs.optionalString,
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
var placeWebsiteProp = defineProperty("place:website", {
	codec: codecs.optionalString,
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
var placePhoneProp = defineProperty("place:phone", {
	codec: codecs.optionalString,
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
var placeCategoriesProp = defineProperty("place:categories", {
	codec: codecs.list(codecs.string),
	defaultValue: [],
	changeScope: ChangeScope.BlockDefault
});
/** Reference from any block to a Place. Single ref for v1 — promote to
*  refList if multi-location-per-block becomes a real need. */
var locationProp = defineProperty("location", {
	codec: optionalRefCodec({ targetTypes: [PLACE_TYPE_ID] }),
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
var PLACE_PROPERTY_SCHEMAS = [
	placeLatProp,
	placeLngProp,
	placeAddressProp,
	placeGooglePlaceIdProp,
	placeGoogleMapsUrlProp,
	placeWebsiteProp,
	placePhoneProp,
	placeCategoriesProp
];
var GEO_PROPERTY_SCHEMAS = [...PLACE_PROPERTY_SCHEMAS, locationProp];
//#endregion
export { GEO_PROPERTY_SCHEMAS, PLACE_PROPERTY_SCHEMAS, locationProp, placeAddressProp, placeCategoriesProp, placeGoogleMapsUrlProp, placeGooglePlaceIdProp, placeLatProp, placeLngProp, placePhoneProp, placeWebsiteProp };

//# sourceMappingURL=properties.js.map