import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
import {
  reviewDeckStartedProp,
  reviewDeckTagProp,
  reviewProgressProp,
  srsReviewDeckType,
  srsReviewProgressType,
} from './schema.ts'

export const srsReviewDataExtension: AppExtension = [
  definitionSeedsFacet.of(reviewDeckTagProp, {source: 'srs-review'}),
  definitionSeedsFacet.of(reviewDeckStartedProp, {source: 'srs-review'}),
  definitionSeedsFacet.of(reviewProgressProp, {source: 'srs-review'}),
  typeSeedsFacet.of(srsReviewDeckType, {source: 'srs-review'}),
  typeSeedsFacet.of(srsReviewProgressType, {source: 'srs-review'}),
]
