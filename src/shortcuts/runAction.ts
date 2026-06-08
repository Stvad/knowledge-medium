import { useCallback } from 'react'
import { actionContextsFacet } from '@/extensions/core.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import {
  useActiveContextsDispatch,
  useActiveContextsState,
} from '@/shortcuts/ActiveContexts.js'
import {
  ActionTrigger,
  type ActionContextConfig,
  type ActionContextType,
} from '@/shortcuts/types.js'
import { getActiveActionById, getEffectiveActions } from './effectiveActions.ts'
import { resolveDeps } from './resolve.ts'

export type RunActionByIdFn = (
  actionId: string,
  trigger: ActionTrigger,
) => void | Promise<void>

let dispatcher: RunActionByIdFn | null = null

/**
 * Installed by <HotkeyReconciler/> on mount. Keeps the module-level
 * `runActionById` in sync with the current FacetRuntime and active contexts.
 */
export function setRunActionDispatcher(next: RunActionByIdFn | null): void {
  dispatcher = next
}

/**
 * Run an action by ID from anywhere — including outside React (e.g. from
 * evaluated code in useAgentRuntimeBridge or one-off imperative callsites).
 *
 * Throws if called before the app mounts <HotkeyReconciler/>.
 */
export const runActionById: RunActionByIdFn = (actionId, trigger) => {
  if (!dispatcher) {
    throw new Error(
      '[runActionById] Dispatcher not installed. Is <HotkeyReconciler/> mounted?',
    )
  }
  return dispatcher(actionId, trigger)
}

/**
 * Hook variant for React callers. Re-computes on runtime/activeContexts changes
 * so consumers re-render when the action's availability changes.
 */
export function useRunAction(): RunActionByIdFn {
  const runtime = useAppRuntime()
  const active = useActiveContextsState()
  const dispatch = useActiveContextsDispatch()

  return useCallback<RunActionByIdFn>(
    (actionId, trigger) => {
      const contextConfigsByType = new Map<ActionContextType, ActionContextConfig>(
        runtime.read(actionContextsFacet).map(c => [c.type, c]),
      )
      const action = getActiveActionById(
        getEffectiveActions(runtime),
        {active, contextConfigsByType},
        actionId,
      )
      if (!action) {
        throw new Error(`[useRunAction] Active action with ID "${actionId}" not found.`)
      }
      const deps = resolveDeps(action, active, contextConfigsByType)
      if (!deps) throw new Error(`[useRunAction] Context "${action.context}" is not active.`)
      return action.handler(deps, trigger, dispatch)
    },
    [runtime, active, dispatch],
  )
}
