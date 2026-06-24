import { propertySchemasFacet, queriesFacet } from '@/data/facets.js'
import { pluginPrefsExtension } from '@/data/pluginStateExtensions.js'
import type { AppExtension } from '@/facets/facet.js'
import {
  groupedBacklinksDefaultsProp,
  groupedBacklinksOverridesProp,
  groupedBacklinksPrefsType,
  groupWithProp,
} from './config.ts'
import { groupedBacklinksForBlockQuery } from './query.ts'

export const groupedBacklinksDataExtension: AppExtension = [
  propertySchemasFacet.of(groupedBacklinksDefaultsProp, {source: 'grouped-backlinks'}),
  propertySchemasFacet.of(groupedBacklinksOverridesProp, {source: 'grouped-backlinks'}),
  propertySchemasFacet.of(groupWithProp, {source: 'grouped-backlinks'}),
  queriesFacet.of(groupedBacklinksForBlockQuery, {source: 'grouped-backlinks'}),
  ...pluginPrefsExtension(groupedBacklinksPrefsType, 'grouped-backlinks'),
]
