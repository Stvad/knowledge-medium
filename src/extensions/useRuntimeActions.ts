import { useEffect } from 'react'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { actionManager as defaultActionManager, ActionManager } from '@/shortcuts/ActionManager.ts'

/**
 * Synchronize the singleton ActionManager with the current FacetRuntime.
 *
 * The runtime is the authoritative source of action/context contributions.
 * Whenever it changes (e.g. a new extension generation after dynamic renderers
 * reload) this effect re-syncs the engine, releasing stale actions and
 * installing new ones without requiring a page refresh.
 */
export function useRuntimeActions(engine: ActionManager = defaultActionManager): void {
  const runtime = useAppRuntime()

  useEffect(() => {
    engine.sync(runtime)
  }, [engine, runtime])
}
