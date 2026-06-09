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
  type BaseShortcutDependencies,
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

export type DispatchActionWithDepsFn = (
  actionId: string,
  deps: Partial<BaseShortcutDependencies>,
  trigger: ActionTrigger,
) => boolean

let withDepsDispatcher: DispatchActionWithDepsFn | null = null

/**
 * Installed by <HotkeyReconciler/> on mount; torn down on unmount so stray
 * callers fail soft (no dispatch) rather than against a stale runtime.
 */
export function setActionWithDepsDispatcher(next: DispatchActionWithDepsFn | null): void {
  withDepsDispatcher = next
}

/**
 * Run a known action by id with caller-SUPPLIED deps, through the same
 * `resolve` + run-until-handled path the keyboard and pointer coordinators
 * use. Unlike `runActionById`, the action's context need NOT be keyboard-active
 * — the caller (the swipe gesture, a quick-action menu button) holds the deps,
 * and the gesture is itself the activation. The supplied deps are validated at
 * the dispatch boundary (`resolveDeps`); a declining `canDispatch` or a synchronous
 * `false` return falls through like any other candidate.
 *
 * Returns true when a candidate handled (or threw), false when none matched or
 * every candidate declined — so the caller can fall back to a default. No-op
 * returning false before the coordinator mounts.
 */
export const dispatchActionWithDeps: DispatchActionWithDepsFn = (actionId, deps, trigger) =>
  withDepsDispatcher ? withDepsDispatcher(actionId, deps, trigger) : false

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
      // The not-handled sentinel (sync `false`) only drives the coordinator's
      // candidate fall-through; imperative callers have no next candidate, so
      // coerce it away to keep the `void | Promise<void>` contract.
      const result = action.handler(deps, trigger, dispatch)
      return result === false ? undefined : result
    },
    [runtime, active, dispatch],
  )
}
