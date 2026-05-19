import { propertySchemasFacet, queriesFacet, typesFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import {
  groupedBacklinksDefaultsProp,
  groupedBacklinksOverridesProp,
  groupedBacklinksPrefsType,
} from './config.ts'
import { groupedBacklinksForBlockQuery } from './query.ts'

export const groupedBacklinksDataExtension: AppExtension = [
  propertySchemasFacet.of(groupedBacklinksDefaultsProp, {source: 'grouped-backlinks'}),
  propertySchemasFacet.of(groupedBacklinksOverridesProp, {source: 'grouped-backlinks'}),
  queriesFacet.of(groupedBacklinksForBlockQuery, {source: 'grouped-backlinks'}),
  typesFacet.of(groupedBacklinksPrefsType, {source: 'grouped-backlinks'}),
]
