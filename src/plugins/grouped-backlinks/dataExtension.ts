import { definitionSeedsFacet, queriesFacet, valuePresetCoresFacet } from '@/data/facets.js'
import { pluginPrefsExtension } from '@/data/pluginStateExtensions.js'
import type { AppExtension } from '@/facets/facet.js'
import {
  groupedBacklinksDefaultsProp,
  groupedBacklinksConfigPresetCore,
  groupedBacklinksOverridesProp,
  groupedBacklinksOverridesPresetCore,
  groupedBacklinksPrefsType,
  groupWithProp,
} from './config.ts'
import { groupedBacklinksForBlockQuery } from './query.ts'

export const groupedBacklinksDataExtension: AppExtension = [
  definitionSeedsFacet.of(groupedBacklinksDefaultsProp, {source: 'grouped-backlinks'}),
  definitionSeedsFacet.of(groupedBacklinksOverridesProp, {source: 'grouped-backlinks'}),
  definitionSeedsFacet.of(groupWithProp, {source: 'grouped-backlinks'}),
  valuePresetCoresFacet.of(groupedBacklinksConfigPresetCore, {source: 'grouped-backlinks'}),
  valuePresetCoresFacet.of(groupedBacklinksOverridesPresetCore, {source: 'grouped-backlinks'}),
  queriesFacet.of(groupedBacklinksForBlockQuery, {source: 'grouped-backlinks'}),
  ...pluginPrefsExtension(groupedBacklinksPrefsType, 'grouped-backlinks'),
]
