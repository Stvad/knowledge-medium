/** Data-layer contributions for the geo plugin — types, property
 *  schemas, queries, and the CodeMirror surface (theme + `@`
 *  completion source via languageData). Composed into the user-facing
 *  `geoPlugin` in `./index.ts`. */

import {
  definitionSeedsFacet,
  queriesFacet,
  systemPagesFacet,
  typesFacet,
} from '@/data/facets'
import { codeMirrorExtensionsFacet } from '@/editor/codeMirrorExtensions'
import type { AppExtension } from '@/facets/facet'
import { GEO_TYPE_CONTRIBUTIONS } from './blockTypes'
import { GEO_PROPERTY_SCHEMAS } from './properties'
import { geoCodeMirrorExtensions } from './codeMirrorExtensions'
import { getOrCreateLocationsPage } from './locationsPage'
import { placesUnderBlockQuery } from './query'

export const geoDataExtension: AppExtension = [
  GEO_TYPE_CONTRIBUTIONS.map(t => typesFacet.of(t, {source: 'geo'})),
  GEO_PROPERTY_SCHEMAS.map(s => definitionSeedsFacet.of(s, {source: 'geo'})),
  queriesFacet.of(placesUnderBlockQuery, {source: 'geo'}),
  codeMirrorExtensionsFacet.of(geoCodeMirrorExtensions, {source: 'geo'}),
  // Eagerly materialise the Locations page at bootstrap so `[[Locations]]`
  // resolves to it instead of auto-creating a rival claimant (alias.collision).
  // NOTE: this makes every workspace get a Locations page on creation, where it
  // was previously created lazily after the first Place.
  systemPagesFacet.of({id: 'geo:locations', ensure: getOrCreateLocationsPage}, {source: 'geo'}),
]
