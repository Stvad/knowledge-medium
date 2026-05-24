/** Geo-plugin block types. `PLACE_TYPE` blocks hold a single physical-
 *  world location (Google POI or ad-hoc coord pin). `LOCATIONS_PAGE_TYPE`
 *  marks the singleton parent page under which Place blocks live in each
 *  workspace — same pattern as the kernel's PROPERTIES_PAGE / TYPES_PAGE.
 *
 *  Type id strings must match `PLACE_TYPE_ID` in `./properties.ts` —
 *  duplicated as a literal there to break the import cycle. */

import { defineBlockType, type TypeContribution } from '@/data/api'
import { aliasesProp } from '@/data/internals/coreProperties'
import { PLACE_PROPERTY_SCHEMAS } from './properties'

export const PLACE_TYPE = 'place'
export const LOCATIONS_PAGE_TYPE = 'panel:locations'

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
    id: LOCATIONS_PAGE_TYPE,
    label: 'Locations page',
    properties: [aliasesProp],
  }),
]
