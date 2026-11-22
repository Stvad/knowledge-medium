import {
  definitionSeedsFacet,
  queriesFacet,
  invalidationRulesFacet,
  valuePresetCoresFacet,
} from '@/data/facets.js'
import { pluginPrefsExtension } from '@/data/pluginStateExtensions.js'
import type { AppExtension } from '@/facets/facet.js'
import { backlinkPresentationInvalidation } from './presentationInvalidation'
import { backlinksForBlockQuery } from './query.ts'
import { backlinksCountForBlockQuery } from './inline-counts/countQuery.ts'
import { backlinksFilterPresetCore, backlinksFilterProp } from './filterProperty.ts'
import { backlinksPrefsType, dailyNoteBacklinksDefaultsProp } from './dailyNoteDefaults.ts'

export const backlinksDataExtension: AppExtension = [
  invalidationRulesFacet.of(backlinkPresentationInvalidation, {source: 'backlinks'}),
  queriesFacet.of(backlinksForBlockQuery, {source: 'backlinks'}),
  queriesFacet.of(backlinksCountForBlockQuery, {source: 'backlinks'}),
  definitionSeedsFacet.of(backlinksFilterProp, {source: 'backlinks'}),
  definitionSeedsFacet.of(dailyNoteBacklinksDefaultsProp, {source: 'backlinks'}),
  valuePresetCoresFacet.of(backlinksFilterPresetCore, {source: 'backlinks'}),
  ...pluginPrefsExtension(backlinksPrefsType, 'backlinks'),
]
