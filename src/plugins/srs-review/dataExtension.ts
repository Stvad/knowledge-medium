import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'
import { pluginPrefsExtension } from '@/data/pluginStateExtensions.js'
import type { AppExtension } from '@/facets/facet.js'
import {
  dailyNoteDecksProp,
  reviewDeckStartedProp,
  reviewDeckTagProp,
  reviewProgressProp,
  srsReviewDeckType,
  srsReviewPrefsType,
  srsReviewProgressType,
} from './schema.ts'

export const srsReviewDataExtension: AppExtension = [
  definitionSeedsFacet.of(reviewDeckTagProp, {source: 'srs-review'}),
  definitionSeedsFacet.of(reviewDeckStartedProp, {source: 'srs-review'}),
  definitionSeedsFacet.of(reviewProgressProp, {source: 'srs-review'}),
  definitionSeedsFacet.of(dailyNoteDecksProp, {source: 'srs-review'}),
  typeSeedsFacet.of(srsReviewDeckType, {source: 'srs-review'}),
  typeSeedsFacet.of(srsReviewProgressType, {source: 'srs-review'}),
  // Not a bare typeSeedsFacet registration: the helper hides the container
  // type from `#` completion and eagerly bootstraps the prefs sub-block so
  // the deck selection is discoverable in Preferences before any picker
  // or hint has mounted.
  ...pluginPrefsExtension(srsReviewPrefsType, 'srs-review'),
]
