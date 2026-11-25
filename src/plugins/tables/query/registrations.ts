import { useMemo, useSyncExternalStore } from 'react'
import type { AnyPropertySchema } from '@/data/api'
import { queryableFieldsFacet, refTargetComparablePropertiesFacet } from '@/data/facets'
import { resolveRefTargetComparableProperty } from '@/data/refTargetComparableProperty'
import { useAppRuntime } from '@/extensions/runtimeContext'
import type { FacetRuntime } from '@/facets/facet'

const facets = [queryableFieldsFacet, refTargetComparablePropertiesFacet] as const

export const readTableQueryFacets = (runtime: FacetRuntime | null, workspaceId: string) => ({
  fields: runtime?.read(queryableFieldsFacet, workspaceId),
  targets: runtime?.read(refTargetComparablePropertiesFacet, workspaceId),
})

export type TableQueryFacets = ReturnType<typeof readTableQueryFacets>

const tableQueryFacetStore = (runtime: FacetRuntime, workspaceId: string) => {
  // Reads for an inactive workspace return fresh maps even between changes.
  let snapshot = readTableQueryFacets(runtime, workspaceId)
  const getSnapshot = () => snapshot
  const subscribe = (notify: () => void) => {
    const refresh = () => {
      const next = readTableQueryFacets(runtime, workspaceId)
      if (snapshot.fields === next.fields && snapshot.targets === next.targets) return
      snapshot = next
      notify()
    }
    const unsubscribes = facets.map(facet => runtime.onFacetChange(facet.id, refresh))
    refresh()
    return () => unsubscribes.forEach(unsubscribe => unsubscribe())
  }
  return {getSnapshot, subscribe}
}

export const useTableQueryFacets = (workspaceId: string): TableQueryFacets => {
  const runtime = useAppRuntime()
  const store = useMemo(() => tableQueryFacetStore(runtime, workspaceId), [runtime, workspaceId])
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export const refValueTarget = (
  schema: AnyPropertySchema, properties: ReadonlyMap<string, AnyPropertySchema> | null, facets: TableQueryFacets,
): AnyPropertySchema | undefined =>
  resolveRefTargetComparableProperty(schema, properties, {...facets, allowLists: false})
