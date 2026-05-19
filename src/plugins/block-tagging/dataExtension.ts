import { propertySchemasFacet } from '@/data/facets.ts'
import { pluginPrefsExtension } from '@/data/pluginStateExtensions.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { blockTaggingPrefsType, blockTagsConfigProp } from './config.ts'

export const blockTaggingDataExtension: AppExtension = [
  propertySchemasFacet.of(blockTagsConfigProp, {source: 'block-tagging'}),
  ...pluginPrefsExtension(blockTaggingPrefsType, 'block-tagging'),
]
