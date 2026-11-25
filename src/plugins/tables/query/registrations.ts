import { useMemo, useSyncExternalStore } from 'react'
import { isRefCodec, memberCodecOf, type AnyPropertySchema } from '@/data/api'
import { queryableFieldsFacet, refTargetComparablePropertiesFacet } from '@/data/facets'
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

/** A scalar reference can compare through one property shared by its target types. */
export const refValueTarget = (
  schema: AnyPropertySchema, properties: ReadonlyMap<string, AnyPropertySchema> | null, facets: TableQueryFacets,
): AnyPropertySchema | undefined => {
  const {fields, targets} = facets
  if (!targets || fields?.has(schema.name) || !isRefCodec(schema.codec) || memberCodecOf(schema.codec)) return undefined
  const targetTypes = schema.codec.targetTypes
  const firstType = targetTypes[0]
  const property = firstType === undefined ? undefined : targets.get(firstType)?.property
  if (property === undefined || !targetTypes.every(type => targets.get(type)?.property === property)) return undefined
  if (fields?.has(property)) return undefined
  const inner = properties?.get(property)
  return inner?.codec.where && !memberCodecOf(inner.codec) ? inner : undefined
}
