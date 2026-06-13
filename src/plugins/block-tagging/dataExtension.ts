import { propertySchemasFacet } from '@/data/facets.js'
import { pluginPrefsExtension } from '@/data/pluginStateExtensions.js'
import type { AppExtension } from '@/facets/facet.js'
import { blockTaggingPrefsType, blockTagsConfigProp } from './config.ts'

export const blockTaggingDataExtension: AppExtension = [
  propertySchemasFacet.of(blockTagsConfigProp, {source: 'block-tagging'}),
  ...pluginPrefsExtension(blockTaggingPrefsType, 'block-tagging'),
]
