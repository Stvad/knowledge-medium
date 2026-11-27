/** Data-layer contributions for the character-counter plugin — the
 *  `char-counter` and `word-counter` block types, the word counter's initial
 *  values, and the `char:*` property schemas.
 *  Composed into the user-facing `characterCounterPlugin` in `./index.ts`. */

import { definitionSeedsFacet, queriesFacet, sameTxProcessorsFacet, typeSeedsFacet } from '@/data/facets'
import type { AppExtension } from '@/facets/facet'
import { CHAR_COUNTER_TYPE_CONTRIBUTIONS, wordCounterInitialValues } from './blockType'
import { charExcludeProp, charLimitProp, charProfileProp, charScopeProp } from './properties'
import { counterSubtreeQuery } from './subtree'

export const characterCounterDataExtension: AppExtension = [
  CHAR_COUNTER_TYPE_CONTRIBUTIONS.map(t => typeSeedsFacet.of(t, {source: 'character-counter'})),
  sameTxProcessorsFacet.of(wordCounterInitialValues, {source: 'character-counter'}),
  queriesFacet.of(counterSubtreeQuery, {source: 'character-counter'}),
  [
    charLimitProp,
    charScopeProp,
    charProfileProp,
    charExcludeProp,
  ].map(prop => definitionSeedsFacet.of(prop, {source: 'character-counter'})),
]
