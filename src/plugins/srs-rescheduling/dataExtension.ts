import { propertySchemasFacet, typesFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import {
  srsArchivedProp,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
  srsSm25Type,
} from './schema.ts'

export const srsReschedulingDataExtension: AppExtension = [
  propertySchemasFacet.of(srsIntervalProp, {source: 'srs-rescheduling'}),
  propertySchemasFacet.of(srsFactorProp, {source: 'srs-rescheduling'}),
  propertySchemasFacet.of(srsNextReviewDateProp, {source: 'srs-rescheduling'}),
  propertySchemasFacet.of(srsReviewCountProp, {source: 'srs-rescheduling'}),
  propertySchemasFacet.of(srsGradeProp, {source: 'srs-rescheduling'}),
  propertySchemasFacet.of(srsArchivedProp, {source: 'srs-rescheduling'}),
  propertySchemasFacet.of(srsSnapshotHistoryProp, {source: 'srs-rescheduling'}),
  typesFacet.of(srsSm25Type, {source: 'srs-rescheduling'}),
]
