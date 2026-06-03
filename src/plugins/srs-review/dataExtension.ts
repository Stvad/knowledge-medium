import { propertySchemasFacet, typesFacet } from '@/data/facets.js'
import type { AppExtension } from '@/extensions/facet.js'
import {
  reviewDeckStartedProp,
  reviewDeckTagProp,
  reviewProgressProp,
  srsReviewDeckType,
  srsReviewProgressType,
} from './schema.ts'

export const srsReviewDataExtension: AppExtension = [
  propertySchemasFacet.of(reviewDeckTagProp, {source: 'srs-review'}),
  propertySchemasFacet.of(reviewDeckStartedProp, {source: 'srs-review'}),
  propertySchemasFacet.of(reviewProgressProp, {source: 'srs-review'}),
  typesFacet.of(srsReviewDeckType, {source: 'srs-review'}),
  typesFacet.of(srsReviewProgressType, {source: 'srs-review'}),
]
