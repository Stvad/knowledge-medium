import {
  propertySchemasFacet,
  queriesFacet,
} from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { backlinksForBlockQuery } from './query.ts'
import { backlinksFilterProp } from './filterProperty.ts'
import { dailyNoteBacklinksDefaultsProp } from './dailyNoteDefaults.ts'

export const backlinksDataExtension: AppExtension = [
  queriesFacet.of(backlinksForBlockQuery, {source: 'backlinks'}),
  propertySchemasFacet.of(backlinksFilterProp, {source: 'backlinks'}),
  propertySchemasFacet.of(dailyNoteBacklinksDefaultsProp, {source: 'backlinks'}),
]
