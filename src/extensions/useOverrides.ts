/**
 * React hook owning the runtime-toggle overrides map for a workspace.
 *
 * Combines two pieces that have to move together for the toggle
 * pipeline to be correct:
 *
 *   1. **Sync read of the localStorage cache** at mount/render — so the
 *      first paint sees the user's most recent intent without waiting
 *      for PowerSync to hydrate the System Plugins block.
 *   2. **Subscribe to `appRuntimeUpdateEvent`** — when the meta-plugin's
 *      subscription effect dispatches a refresh (cache diverged from
 *      the synced block), bump local state so the memo invalidates and
 *      re-reads the cache.
 *
 * The pair is one unit because they share an invariant: every
 * `refreshAppRuntime()` dispatch is meaningful exactly because the
 * caller has already updated the cache. Splitting them risks a memo
 * that re-runs but doesn't re-read, or a re-read that doesn't take
 * effect.
 *
 * Returns an empty map when `workspaceId` is null/undefined — that's
 * the pre-workspace boot state and matches "no overrides, use manifest
 * defaults".
 */

import {useEffect, useMemo, useState} from 'react'
import {readOverridesCache} from '@/extensions/overridesCache.ts'
import {appRuntimeUpdateEvent} from '@/extensions/runtimeEvents.ts'
import type {Overrides} from '@/extensions/togglable.ts'

export interface UseOverridesResult {
  overrides: Overrides
  /** Monotonic string updated on each `refreshAppRuntime()` dispatch.
   *  Callers thread this into their resolver context so consumers can
   *  see that the runtime has been rebuilt even when the override map
   *  itself hasn't changed (e.g. extension content edits dispatch
   *  refresh too). */
  generation: string
}

const INITIAL_GENERATION = 'initial-load'

export const useOverrides = (
  workspaceId: string | undefined | null,
): UseOverridesResult => {
  const [generation, setGeneration] = useState(INITIAL_GENERATION)

  useEffect(() => {
    const reloadRuntime = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail
      setGeneration(detail ?? new Date().toISOString())
    }
    window.addEventListener(appRuntimeUpdateEvent, reloadRuntime)
    return () => window.removeEventListener(appRuntimeUpdateEvent, reloadRuntime)
  }, [])

  const overrides = useMemo(() => {
    if (!workspaceId) return new Map<string, boolean>()
    return readOverridesCache(workspaceId)
    // `generation` is included so refresh dispatches invalidate the
    // memo even when workspaceId is stable. The cache read is the
    // side-effect that actually produces the new value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, generation])

  return {overrides, generation}
}
