import { useState, useEffect, useMemo } from 'react'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command'
import { useCommandPaletteShortcuts } from '@/shortcuts/useActionContext.ts'
import { useAvailableActions } from '@/shortcuts/useAvailableActions.ts'
import { useRunAction } from '@/shortcuts/runAction.ts'
import { ActionConfig, ShortcutBinding, ActionContextType } from '@/shortcuts/types.ts'
import { Kbd } from '@/components/ui/kbd'
import { groupBy } from 'lodash'

const formatShortcutKeys = (bindings: readonly ShortcutBinding[]): string[] => {
  if (!bindings || bindings.length === 0) {
    return []
  }
  return bindings.flatMap(binding =>
    Array.isArray(binding.keys) ? binding.keys : [binding.keys],
  )
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)

  const shortcutDependencies = useMemo(() => ({}), [])

  useCommandPaletteShortcuts(shortcutDependencies, open)

  useEffect(() => {
    const handleToggle = () => {
      setOpen((currentOpen) => !currentOpen)
    }
    window.addEventListener('toggle-command-palette', handleToggle)
    return () => window.removeEventListener('toggle-command-palette', handleToggle)
  }, [])

  const {actions, activeContexts, bindingsFor} = useAvailableActions()
  const runAction = useRunAction()

  const {activeContextsInfo, groupedActions} = useMemo(() => {
    if (!open) {
      return {activeContextsInfo: [], groupedActions: {} as Record<ActionContextType, ActionConfig[]>}
    }
    const activeInfo = [...activeContexts].reverse() // Reverse order of activation
    const groups = groupBy(actions, 'context') as Record<ActionContextType, ActionConfig[]>
    return {activeContextsInfo: activeInfo, groupedActions: groups}
  }, [open, actions, activeContexts])

  const runCommand = (actionId: string) => {
    try {
      runAction(actionId, new CustomEvent('command-pallet-trigger'))
    } catch (error) {
      console.error(`[CommandPalette] Failed to execute action: ${actionId}`, error)
    } finally {
      setOpen(false)
    }
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..."/>
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {activeContextsInfo.map(({config}) => {
          const contextType = config.type
          const actionsInGroup = groupedActions[contextType]

          if (!actionsInGroup || actionsInGroup.length === 0) {
            return null
          }
          const groupHeading = config.displayName || contextType

          return (
            <CommandGroup key={contextType} heading={groupHeading}>
              {actionsInGroup.map((action: ActionConfig) => {
                const bindings = bindingsFor(action.id)
                const shortcutKeys = formatShortcutKeys(bindings)
                return (
                  <CommandItem
                    key={action.id}
                    value={`${groupHeading} ${action.description}`}
                    onSelect={() => runCommand(action.id)}
                    className="flex justify-between items-center"
                  >
                    <span>{action.description}</span>
                    {shortcutKeys.length > 0 && (
                      <div className="flex gap-1">
                        {shortcutKeys.map((keyStr, index) => (
                          <Kbd key={index}>{keyStr}</Kbd>
                        ))}
                      </div>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          )
        })}
      </CommandList>
    </CommandDialog>
  )
}
