import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
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
  definitionSeedsFacet.of(srsIntervalProp, {source: 'srs-rescheduling'}),
  definitionSeedsFacet.of(srsFactorProp, {source: 'srs-rescheduling'}),
  definitionSeedsFacet.of(srsNextReviewDateProp, {source: 'srs-rescheduling'}),
  definitionSeedsFacet.of(srsReviewCountProp, {source: 'srs-rescheduling'}),
  definitionSeedsFacet.of(srsGradeProp, {source: 'srs-rescheduling'}),
  definitionSeedsFacet.of(srsArchivedProp, {source: 'srs-rescheduling'}),
  definitionSeedsFacet.of(srsSnapshotHistoryProp, {source: 'srs-rescheduling'}),
  typeSeedsFacet.of(srsSm25Type, {source: 'srs-rescheduling'}),
]
