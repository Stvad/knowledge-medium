import { useMemo } from 'react'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts.tsx'
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
  bindingsFor: (actionId: string) => readonly ShortcutBinding[]
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
      action => active.has(action.context) && action.id !== COMMAND_PALETTE_ACTION_ID,
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
