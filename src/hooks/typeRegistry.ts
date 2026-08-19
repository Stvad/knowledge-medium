import { useCallback, useSyncExternalStore } from 'react'
import { type TypeContribution } from '@/data/api'
import { useRepo } from '@/context/repo.js'

/** Reactive view onto `repo.types` (the merged type registry: kernel +
 *  plugin + user-defined contributions). Fires on full
 *  `setFacetRuntime` rebuilds AND on per-facet runtime contribution
 *  updates (e.g. `UserTypesService` publishing a user-defined type).
 *  Mirrors `usePropertySchemas`; the memoized subscribe matters — an
 *  inline arrow would re-subscribe on every render of every consumer
 *  (the supertags chip decorator wraps every block). */
export const useTypes = (): ReadonlyMap<string, TypeContribution> => {
  const repo = useRepo()
  const subscribe = useCallback(
    (cb: () => void) => repo.onTypesChange(cb),
    [repo],
  )
  return useSyncExternalStore(
    subscribe,
    () => repo.types,
    () => repo.types,
  )
}
