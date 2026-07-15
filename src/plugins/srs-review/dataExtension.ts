import { definitionSeedsFacet, typesFacet } from '@/data/facets.js'
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
  typesFacet.of(srsReviewDeckType, {source: 'srs-review'}),
  typesFacet.of(srsReviewProgressType, {source: 'srs-review'}),
]
