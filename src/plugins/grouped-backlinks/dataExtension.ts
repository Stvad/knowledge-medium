import { propertySchemasFacet, queriesFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import {
  groupedBacklinksDefaultsProp,
  groupedBacklinksOverridesProp,
} from './config.ts'
import { groupedBacklinksForBlockQuery } from './query.ts'

export const groupedBacklinksDataExtension: AppExtension = [
  propertySchemasFacet.of(groupedBacklinksDefaultsProp, {source: 'grouped-backlinks'}),
  propertySchemasFacet.of(groupedBacklinksOverridesProp, {source: 'grouped-backlinks'}),
  queriesFacet.of(groupedBacklinksForBlockQuery, {source: 'grouped-backlinks'}),
]
