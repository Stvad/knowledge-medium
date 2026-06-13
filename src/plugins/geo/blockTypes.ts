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

import { defineBlockType, type TypeContribution } from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { PLACE_PROPERTY_SCHEMAS } from './properties'

export const PLACE_TYPE = 'place'
export const MAP_TYPE = 'map'

export const GEO_TYPE_CONTRIBUTIONS: readonly TypeContribution[] = [
  defineBlockType({
    id: PLACE_TYPE,
    label: 'Place',
    description: 'A physical-world location — Google POI or an ad-hoc coordinate pin.',
    // Lift place:* fields so `addType('place')` materialises their
    // defaults and the property panel surfaces them via the type
    // section. `location` is deliberately NOT lifted here — it's the
    // *referencing* property other blocks use, not a field of a Place.
    properties: [...PLACE_PROPERTY_SCHEMAS],
  }),
  defineBlockType({
    id: MAP_TYPE,
    label: 'Map',
    description: 'Renders an inline map of the places under this block (Places themselves, or any block with a `location` ref).',
    properties: [aliasesProp],
  }),
]
