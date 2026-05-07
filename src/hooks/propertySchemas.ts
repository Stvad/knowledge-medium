import { useCallback, useSyncExternalStore } from 'react'
import { type AnyPropertySchema } from '@/data/api'
import { useRepo } from '@/context/repo.tsx'

/** Reactive view onto `repo.propertySchemas`. Fires on full
 *  `setFacetRuntime` rebuilds AND on per-facet runtime contribution
 *  updates (e.g. `UserSchemasService` adding a user-data schema). */
export const usePropertySchemas = (): ReadonlyMap<string, AnyPropertySchema> => {
  const repo = useRepo()
  const subscribe = useCallback(
    (cb: () => void) => repo.onPropertySchemasChange(cb),
    [repo],
  )
  return useSyncExternalStore(
    subscribe,
    () => repo.propertySchemas,
    () => repo.propertySchemas,
  )
}
