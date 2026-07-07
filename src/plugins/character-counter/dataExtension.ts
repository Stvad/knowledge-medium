/** Data-layer contributions for the character-counter plugin — the
 *  `char-counter` block type and `char:*` property schemas.
 *  Composed into the user-facing `characterCounterPlugin` in `./index.ts`. */

import { propertySchemasFacet, typesFacet } from '@/data/facets'
import type { AppExtension } from '@/facets/facet'
import { CHAR_COUNTER_TYPE_CONTRIBUTIONS } from './blockType'
import { charLimitProp, charProfileProp, charScopeProp } from './properties'

export const characterCounterDataExtension: AppExtension = [
  CHAR_COUNTER_TYPE_CONTRIBUTIONS.map(t => typesFacet.of(t, {source: 'character-counter'})),
  [
    charLimitProp,
    charScopeProp,
    charProfileProp,
  ].map(prop => propertySchemasFacet.of(prop, {source: 'character-counter'})),
]
