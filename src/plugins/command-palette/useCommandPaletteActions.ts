import { useMemo } from 'react'
import { actionContextsFacet } from '@/extensions/core.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts.tsx'
import { actionRuntimeKey, getEffectiveActions } from '@/shortcuts/effectiveActions.ts'
import type {
  ActionConfig,
  ActionContextType,
  ActiveContextInfo,
  ShortcutBinding,
} from '@/shortcuts/types.ts'
import { COMMAND_PALETTE_ACTION_ID } from './context.ts'

export interface CommandPaletteActionsResult {
  actions: readonly ActionConfig[]
  activeContexts: ActiveContextInfo[]
  bindingsFor: (action: Pick<ActionConfig, 'context' | 'id'>) => readonly ShortcutBinding[]
}

const NO_BINDINGS: readonly ShortcutBinding[] = []

export function useCommandPaletteActions(): CommandPaletteActionsResult {
  const runtime = useAppRuntime()
  const active = useActiveContextsState()

  const {contextConfigsByType, bindingsFor} = useMemo(() => {
    const contextConfigs = runtime.read(actionContextsFacet)
    const configsByType = new Map<ActionContextType, typeof contextConfigs[number]>(
      contextConfigs.map(c => [c.type, c]),
    )

    const allActions = getEffectiveActions(runtime)
    const bindingsByActionId = new Map<string, ShortcutBinding[]>()
    for (const action of allActions) {
      if (!action.defaultBinding) continue
      bindingsByActionId.set(actionRuntimeKey(action), [{
        ...action.defaultBinding,
        action: action.id,
      }])
    }

    const getBindings = (action: Pick<ActionConfig, 'context' | 'id'>): readonly ShortcutBinding[] =>
      bindingsByActionId.get(actionRuntimeKey(action)) ?? NO_BINDINGS

    return {contextConfigsByType: configsByType, bindingsFor: getBindings}
  }, [runtime])

  return useMemo(() => {
    const allActions = getEffectiveActions(runtime)

    const actions = allActions.filter(action => {
      if (!active.has(action.context)) return false
      if (action.id === COMMAND_PALETTE_ACTION_ID) return false
      if (!action.canRun) return true
      // The shortcut system stores the active context's dependencies
      // exactly as the handler will receive them, so canRun can run
      // against them directly. An action whose canRun returns false
      // would silently no-op if shown — hide it instead.
      const deps = active.get(action.context)
      if (!deps) return true
      return action.canRun(deps as never)
    })

    const activeContexts: ActiveContextInfo[] = Array.from(active.entries()).flatMap(
      ([type, dependencies]) => {
        const config = contextConfigsByType.get(type)
        return config ? [{config, dependencies}] : []
      },
    )

    return {actions, activeContexts, bindingsFor}
  }, [runtime, active, contextConfigsByType, bindingsFor])
}
