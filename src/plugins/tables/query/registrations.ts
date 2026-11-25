import { useMemo } from 'react'
import type { AnyPropertySchema } from '@/data/api'
import { queryableFieldsFacet, refTargetComparablePropertiesFacet } from '@/data/facets'
import { resolveRefTargetComparableProperty } from '@/data/refTargetComparableProperty'
import { useFacetValue } from '@/hooks/useFacetValue'
import type { FacetRuntime } from '@/facets/facet'

export const readTableQueryFacets = (runtime: FacetRuntime | null, workspaceId: string) => ({
  fields: runtime?.read(queryableFieldsFacet, workspaceId),
  targets: runtime?.read(refTargetComparablePropertiesFacet, workspaceId),
})

export type TableQueryFacets = ReturnType<typeof readTableQueryFacets>

export const useTableQueryFacets = (workspaceId: string): TableQueryFacets => {
  const fields = useFacetValue(queryableFieldsFacet, workspaceId)
  const targets = useFacetValue(refTargetComparablePropertiesFacet, workspaceId)
  return useMemo(() => ({fields, targets}), [fields, targets])
}

export const refValueTarget = (
  schema: AnyPropertySchema, properties: ReadonlyMap<string, AnyPropertySchema> | null, facets: TableQueryFacets,
): AnyPropertySchema | undefined =>
  resolveRefTargetComparableProperty(schema, properties, {...facets, allowLists: false})
