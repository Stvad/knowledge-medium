import { useCallback } from 'react'
import { actionsFacet } from '@/extensions/core.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts.tsx'
import { ActionTrigger } from '@/shortcuts/types.ts'

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

  return useCallback<RunActionByIdFn>(
    (actionId, trigger) => {
      const actions = runtime.read(actionsFacet)
      const action = actions.find(a => a.id === actionId)
      if (!action) {
        throw new Error(`[useRunAction] Action with ID "${actionId}" not found.`)
      }
      const deps = active.get(action.context)
      if (!deps) {
        throw new Error(
          `[useRunAction] Cannot run action "${actionId}". Context "${action.context}" is not active.`,
        )
      }
      return action.handler(deps, trigger)
    },
    [runtime, active],
  )
}
