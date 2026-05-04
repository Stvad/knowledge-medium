import { queriesFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { groupedBacklinksForBlockQuery } from './query.ts'

export const groupedBacklinksDataExtension: AppExtension = [
  queriesFacet.of(groupedBacklinksForBlockQuery, {source: 'grouped-backlinks'}),
]
