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

import { ChangeScope, seedProperty } from '@/data/api'

// String literal here (not an import from `./blockTypes`) to avoid a
// circular dependency: blockTypes lifts these property schemas into the
// PLACE_TYPE contribution. Mirrors the kernel pattern where
// `blockTypePropertiesProp` references `'property-schema'` as a literal.
const PLACE_TYPE_ID = 'place'

export const placeLatProp = seedProperty({
  seedKey: 'system:geo/property/place-lat', revision: 1, name: 'place:lat', preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const placeLngProp = seedProperty({
  seedKey: 'system:geo/property/place-lng', revision: 1, name: 'place:lng', preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const placeAddressProp = seedProperty({
  seedKey: 'system:geo/property/place-address', revision: 1, name: 'place:address', preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const placeGooglePlaceIdProp = seedProperty({
  seedKey: 'system:geo/property/place-google-place-id', revision: 1, name: 'place:googlePlaceId', preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const placeGoogleMapsUrlProp = seedProperty({
  seedKey: 'system:geo/property/place-google-maps-url', revision: 1, name: 'place:googleMapsUrl', preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const placeWebsiteProp = seedProperty({
  seedKey: 'system:geo/property/place-website', revision: 1, name: 'place:website', preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const placePhoneProp = seedProperty({
  seedKey: 'system:geo/property/place-phone', revision: 1, name: 'place:phone', preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const placeCategoriesProp = seedProperty({
  seedKey: 'system:geo/property/place-categories', revision: 1, name: 'place:categories', preset: 'string-list',
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

/** Reference from any block to a Place. Single ref for v1 — promote to
 *  refList if multi-location-per-block becomes a real need. */
export const locationProp = seedProperty({
  seedKey: 'system:geo/property/location', revision: 1, name: 'location', preset: 'optional-ref',
  config: {targetTypes: [PLACE_TYPE_ID]},
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const PLACE_PROPERTY_SCHEMAS = [
  placeLatProp,
  placeLngProp,
  placeAddressProp,
  placeGooglePlaceIdProp,
  placeGoogleMapsUrlProp,
  placeWebsiteProp,
  placePhoneProp,
  placeCategoriesProp,
] as const

export const GEO_PROPERTY_SCHEMAS = [
  ...PLACE_PROPERTY_SCHEMAS,
  locationProp,
] as const
