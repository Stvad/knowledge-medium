/** Data-layer contributions for the geo plugin — types, property
 *  schemas. Queries land here in Phase D, the codeMirror autocomplete
 *  extension in Phase C. Composed into the user-facing `geoPlugin` in
 *  `./index.ts`. */

import {
  propertySchemasFacet,
  queriesFacet,
  typesFacet,
} from '@/data/facets'
import { codeMirrorExtensionsFacet } from '@/extensions/editor'
import type { AppExtension } from '@/extensions/facet'
import { GEO_TYPE_CONTRIBUTIONS } from './blockTypes'
import { GEO_PROPERTY_SCHEMAS } from './properties'
import { geoCodeMirrorExtensions } from './codeMirrorExtensions'
import { placesUnderBlockQuery } from './query'

export const geoDataExtension: AppExtension = [
  GEO_TYPE_CONTRIBUTIONS.map(t => typesFacet.of(t, {source: 'geo'})),
  GEO_PROPERTY_SCHEMAS.map(s => propertySchemasFacet.of(s, {source: 'geo'})),
  queriesFacet.of(placesUnderBlockQuery, {source: 'geo'}),
  codeMirrorExtensionsFacet.of(geoCodeMirrorExtensions, {source: 'geo'}),
]
