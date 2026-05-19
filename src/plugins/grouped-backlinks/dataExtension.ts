import { propertySchemasFacet, queriesFacet } from '@/data/facets.ts'
import { pluginPrefsExtension } from '@/data/pluginStateExtensions.ts'
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
  ...pluginPrefsExtension(groupedBacklinksPrefsType, 'grouped-backlinks'),
]
