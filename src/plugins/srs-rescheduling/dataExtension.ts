import { propertySchemasFacet, typesFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import {
  srsFactorProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsSm25Type,
} from './schema.ts'

export const srsReschedulingDataExtension: AppExtension = [
  propertySchemasFacet.of(srsIntervalProp, {source: 'srs-rescheduling'}),
  propertySchemasFacet.of(srsFactorProp, {source: 'srs-rescheduling'}),
  propertySchemasFacet.of(srsNextReviewDateProp, {source: 'srs-rescheduling'}),
  propertySchemasFacet.of(srsReviewCountProp, {source: 'srs-rescheduling'}),
  typesFacet.of(srsSm25Type, {source: 'srs-rescheduling'}),
]
