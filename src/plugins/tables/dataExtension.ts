import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import type { AppExtension } from '@/facets/facet'
import { tableChildrenQueries } from './childrenViews'
import { TABLE_PROPERTY_SEEDS, TABLE_TYPE_SEEDS } from './schema'

export const tablesDataExtension: AppExtension = [
  TABLE_TYPE_SEEDS.map(seed => typeSeedsFacet.of(seed, {source: 'tables'})),
  TABLE_PROPERTY_SEEDS.map(seed => definitionSeedsFacet.of(seed, {source: 'tables'})),
  tableChildrenQueries,
]
