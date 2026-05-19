import { propertySchemasFacet, typesFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { blockTaggingPrefsType, blockTagsConfigProp } from './config.ts'

export const blockTaggingDataExtension: AppExtension = [
  propertySchemasFacet.of(blockTagsConfigProp, {source: 'block-tagging'}),
  typesFacet.of(blockTaggingPrefsType, {source: 'block-tagging'}),
]
