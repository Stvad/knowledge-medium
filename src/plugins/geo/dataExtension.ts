/** Data-layer contributions for the geo plugin — types, property
 *  schemas, and queries. UI-free (the CodeMirror surface lives in
 *  `./index.ts`) so this is safe for the `pluginDataExtensions` glob.
 *  Composed into the user-facing `geoPlugin` in `./index.ts`. */

import {
  propertySchemasFacet,
  queriesFacet,
  typesFacet,
} from '@/data/facets'
import type { AppExtension } from '@/facets/facet'
import { GEO_TYPE_CONTRIBUTIONS } from './blockTypes'
import { GEO_PROPERTY_SCHEMAS } from './properties'
import { placesUnderBlockQuery } from './query'

export const geoDataExtension: AppExtension = [
  GEO_TYPE_CONTRIBUTIONS.map(t => typesFacet.of(t, {source: 'geo'})),
  GEO_PROPERTY_SCHEMAS.map(s => propertySchemasFacet.of(s, {source: 'geo'})),
  queriesFacet.of(placesUnderBlockQuery, {source: 'geo'}),
]

export default geoDataExtension
