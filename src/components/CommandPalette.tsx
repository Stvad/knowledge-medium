import { useState, useEffect, useMemo } from 'react'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { OpenRouterSettings } from '@/components/settings/OpenRouterSettings'
import { useCommandPaletteShortcuts } from '@/shortcuts/useActionContext.ts'
import { actionManager } from '@/shortcuts/ActionManager.ts'
import { Action, ShortcutBinding, ActionContextType } from '@/shortcuts/types.ts'
import { Kbd } from '@/components/ui/kbd'
import { groupBy } from 'lodash'

const formatShortcutKeys = (bindings: ShortcutBinding[]): string[] => {
  if (!bindings || bindings.length === 0) {
    return []
  }
  return bindings.flatMap(binding =>
    Array.isArray(binding.keys) ? binding.keys : [binding.keys],
  )
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [openSettingsDialog, setOpenSettingsDialog] = useState(false)

  const shortcutDependencies = useMemo(() => ({}), [])

  useCommandPaletteShortcuts(shortcutDependencies, open)

  useEffect(() => {
    const handleToggle = () => {
      setOpen((currentOpen) => !currentOpen)
    }
    window.addEventListener('toggle-command-palette', handleToggle)
    return () => window.removeEventListener('toggle-command-palette', handleToggle)
  }, [])

  const {activeContextsInfo, groupedActions} = useMemo(() => {
    if (!open) {
      return {activeContextsInfo: [], groupedActions: {} as Record<ActionContextType, Action[]>}
    }
    const activeInfo = actionManager.getActiveContexts().reverse() // Reverse order of activation
    const actions = actionManager.getAvailableActions().filter(it => !it.hideFromCommandPallet)
    const groups = groupBy(actions, 'context') as Record<ActionContextType, Action[]>
    return {activeContextsInfo: activeInfo, groupedActions: groups}
  }, [open])

  const runCommand = (actionId: string) => {
    if (actionId === 'open_router_settings') {
      // todo move the open router settings away from here
      setOpen(false)
      setOpenSettingsDialog(true)
      return
    }

    try {
      actionManager.runActionById(actionId)
    } catch (error) {
      console.error(`[CommandPalette] Failed to execute action: ${actionId}`, error)
    } finally {
      setOpen(false)
    }
  }

  return (
    <>
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
                {actionsInGroup.map((action: Action) => {
                  const bindings = actionManager.getBindingsForAction(action.id)
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

      <Dialog open={openSettingsDialog} onOpenChange={setOpenSettingsDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>OpenRouter Settings</DialogTitle>
          </DialogHeader>
          <OpenRouterSettings onSave={() => setOpenSettingsDialog(false)}/>
        </DialogContent>
      </Dialog>
    </>
  )
}
