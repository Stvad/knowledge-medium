import { propertySchemasFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { blockTagsConfigProp } from './config.ts'

export const blockTaggingDataExtension: AppExtension = [
  propertySchemasFacet.of(blockTagsConfigProp, {source: 'block-tagging'}),
]
