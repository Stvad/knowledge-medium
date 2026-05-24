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

import { ChangeScope, codecs, defineProperty, type PropertySchema } from '@/data/api'
import { optionalRefCodec } from './codecs'

// String literal here (not an import from `./blockTypes`) to avoid a
// circular dependency: blockTypes lifts these property schemas into the
// PLACE_TYPE contribution. Mirrors the kernel pattern where
// `blockTypePropertiesProp` references `'property-schema'` as a literal.
const PLACE_TYPE_ID = 'place'

export const placeLatProp = defineProperty<number | undefined>('place:lat', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const placeLngProp = defineProperty<number | undefined>('place:lng', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const placeAddressProp = defineProperty<string | undefined>('place:address', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const placeGooglePlaceIdProp = defineProperty<string | undefined>('place:googlePlaceId', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const placeGoogleMapsUrlProp = defineProperty<string | undefined>('place:googleMapsUrl', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const placeWebsiteProp = defineProperty<string | undefined>('place:website', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const placePhoneProp = defineProperty<string | undefined>('place:phone', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const placeCategoriesProp = defineProperty<readonly string[]>('place:categories', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

/** Reference from any block to a Place. Single ref for v1 — promote to
 *  refList if multi-location-per-block becomes a real need. */
export const locationProp = defineProperty<string | undefined>('location', {
  codec: optionalRefCodec({targetTypes: [PLACE_TYPE_ID]}),
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const PLACE_PROPERTY_SCHEMAS: ReadonlyArray<PropertySchema<unknown>> = [
  placeLatProp,
  placeLngProp,
  placeAddressProp,
  placeGooglePlaceIdProp,
  placeGoogleMapsUrlProp,
  placeWebsiteProp,
  placePhoneProp,
  placeCategoriesProp,
] as ReadonlyArray<PropertySchema<unknown>>

export const GEO_PROPERTY_SCHEMAS: ReadonlyArray<PropertySchema<unknown>> = [
  ...PLACE_PROPERTY_SCHEMAS,
  locationProp as PropertySchema<unknown>,
]
