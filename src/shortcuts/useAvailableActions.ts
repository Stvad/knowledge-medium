import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { actionsFacet } from '@/extensions/core.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { actionManager as defaultActionManager, ActionManager } from '@/shortcuts/ActionManager.ts'
import {
  ActionConfig,
  ActionContextType,
  ActiveContextInfo,
  ShortcutBinding,
} from '@/shortcuts/types.ts'

export interface AvailableActionsResult {
  actions: readonly ActionConfig[]
  activeContexts: ActiveContextInfo[]
  bindingsFor: (actionId: string) => ShortcutBinding[]
}

/**
 * Exposes the currently-available actions from the FacetRuntime, filtered by
 * the engine's active contexts. Automatically re-renders when activations
 * change (via ActionManager.subscribe) or when the runtime regenerates.
 */
export function useAvailableActions(engine: ActionManager = defaultActionManager): AvailableActionsResult {
  const runtime = useAppRuntime()

  const subscribe = useCallback((listener: () => void) => engine.subscribe(listener), [engine])
  const getSnapshot = useCallback(
    () => engine.getActiveContextTypesSnapshot(),
    [engine],
  )

  const activeContextTypes = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return useMemo(() => {
    const activeSet = new Set<ActionContextType>(activeContextTypes)
    const allActions = runtime.read(actionsFacet)

    const actions = allActions.filter(
      action => activeSet.has(action.context) && !action.hideFromCommandPallet,
    )

    return {
      actions,
      activeContexts: engine.getActiveContexts(),
      bindingsFor: (actionId: string) => engine.getBindingsForAction(actionId),
    }
  }, [activeContextTypes, engine, runtime])
}
