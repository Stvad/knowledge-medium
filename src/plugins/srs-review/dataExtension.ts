import { propertySchemasFacet, typesFacet } from '@/data/facets.js'
import type { AppExtension } from '@/extensions/facet.js'
import {
  reviewDeckStartedProp,
  reviewDeckTagProp,
  srsReviewDeckType,
} from './schema.ts'

export const srsReviewDataExtension: AppExtension = [
  propertySchemasFacet.of(reviewDeckTagProp, {source: 'srs-review'}),
  propertySchemasFacet.of(reviewDeckStartedProp, {source: 'srs-review'}),
  typesFacet.of(srsReviewDeckType, {source: 'srs-review'}),
]
