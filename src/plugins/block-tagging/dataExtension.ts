import { definitionSeedsFacet, valuePresetCoresFacet } from '@/data/facets.js'
import { pluginPrefsExtension } from '@/data/pluginStateExtensions.js'
import type { AppExtension } from '@/facets/facet.js'
import { blockTaggingPrefsType, blockTagsConfigPresetCore, blockTagsConfigProp } from './config.ts'

export const blockTaggingDataExtension: AppExtension = [
  definitionSeedsFacet.of(blockTagsConfigProp, {source: 'block-tagging'}),
  valuePresetCoresFacet.of(blockTagsConfigPresetCore, {source: 'block-tagging'}),
  ...pluginPrefsExtension(blockTaggingPrefsType, 'block-tagging'),
]
