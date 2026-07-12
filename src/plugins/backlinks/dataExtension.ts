import {
  propertySchemasFacet,
  queriesFacet,
  valuePresetCoresFacet,
} from '@/data/facets.js'
import { pluginPrefsExtension } from '@/data/pluginStateExtensions.js'
import type { AppExtension } from '@/facets/facet.js'
import { backlinksForBlockQuery } from './query.ts'
import { backlinksFilterPresetCore, backlinksFilterProp } from './filterProperty.ts'
import { backlinksPrefsType, dailyNoteBacklinksDefaultsProp } from './dailyNoteDefaults.ts'

export const backlinksDataExtension: AppExtension = [
  queriesFacet.of(backlinksForBlockQuery, {source: 'backlinks'}),
  propertySchemasFacet.of(backlinksFilterProp, {source: 'backlinks'}),
  propertySchemasFacet.of(dailyNoteBacklinksDefaultsProp, {source: 'backlinks'}),
  valuePresetCoresFacet.of(backlinksFilterPresetCore, {source: 'backlinks'}),
  ...pluginPrefsExtension(backlinksPrefsType, 'backlinks'),
]
