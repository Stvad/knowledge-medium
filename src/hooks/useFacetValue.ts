import { useMemo, useSyncExternalStore } from 'react'
import { useAppRuntime } from '@/extensions/runtimeContext'
import type { Facet, FacetRuntime } from '@/facets/facet'

const facetStore = <Input, Output>(runtime: FacetRuntime, facet: Facet<Input, Output>, workspaceId?: string) => {
  // Inactive workspaces recompute on read. React needs a stable snapshot between notifications.
  let value = runtime.read(facet, workspaceId)
  const getSnapshot = () => value
  const subscribe = (notify: () => void) => {
    const refresh = () => {
      value = runtime.read(facet, workspaceId)
      notify()
    }
    const stop = runtime.onFacetChange(facet.id, refresh)
    refresh()
    return stop
  }
  return {getSnapshot, subscribe}
}

/** Read a workspace's current facet value and follow registration changes. */
export const useFacetValue = <Input, Output>(facet: Facet<Input, Output>, workspaceId?: string): Output => {
  const runtime = useAppRuntime()
  const store = useMemo(() => facetStore(runtime, facet, workspaceId), [runtime, facet, workspaceId])
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
