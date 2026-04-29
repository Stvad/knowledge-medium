import { useMemo } from 'react'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts.tsx'
import {
  ActionConfig,
  ActionContextType,
  ActiveContextInfo,
  ShortcutBinding,
} from '@/shortcuts/types.ts'

export interface AvailableActionsResult {
  /** Actions whose context is currently active (filtered for command-palette visibility). */
  actions: readonly ActionConfig[]
  /**
   * Currently-active contexts with their configs and dependencies.
   * Iteration order reflects activation order (most-recent last).
   */
  activeContexts: ActiveContextInfo[]
  /** Returns the bindings declared for a given action id (empty array if none). */
  bindingsFor: (actionId: string) => readonly ShortcutBinding[]
}

// Stable empty-result the `bindingsFor` fallback can share, keeping its
// return value referentially stable across calls.
const NO_BINDINGS: readonly ShortcutBinding[] = []

/**
 * Exposes the currently-available actions to UI consumers (e.g. the command
 * palette). All state is derived from the facet runtime and the
 * ActiveContextsProvider — no singleton engine involved.
 */
export function useAvailableActions(): AvailableActionsResult {
  const runtime = useAppRuntime()
  const active = useActiveContextsState()

  // Derived purely from the runtime — doesn't depend on `active`, so it only
  // recomputes when the extension graph regenerates. `bindingsFor`'s function
  // identity is therefore stable across activation changes, which is what
  // consumers putting it in dep arrays expect.
  const {contextConfigsByType, bindingsFor} = useMemo(() => {
    const contextConfigs = runtime.read(actionContextsFacet)
    const configsByType = new Map<ActionContextType, typeof contextConfigs[number]>(
      contextConfigs.map(c => [c.type, c]),
    )

    const allActions = runtime.read(actionsFacet)
    const bindingsByActionId = new Map<string, ShortcutBinding[]>()
    for (const action of allActions) {
      if (!action.defaultBinding) continue
      bindingsByActionId.set(action.id, [{
        ...action.defaultBinding,
        action: action.id,
      }])
    }

    const getBindings = (actionId: string): readonly ShortcutBinding[] =>
      bindingsByActionId.get(actionId) ?? NO_BINDINGS

    return {contextConfigsByType: configsByType, bindingsFor: getBindings}
  }, [runtime])

  return useMemo(() => {
    const allActions = runtime.read(actionsFacet)

    const actions = allActions.filter(
      action => active.has(action.context) && !action.hideFromCommandPallet,
    )

    const activeContexts: ActiveContextInfo[] = Array.from(active.entries()).flatMap(
      ([type, dependencies]) => {
        const config = contextConfigsByType.get(type)
        return config ? [{config, dependencies}] : []
      },
    )

    return {actions, activeContexts, bindingsFor}
  }, [runtime, active, contextConfigsByType, bindingsFor])
}
