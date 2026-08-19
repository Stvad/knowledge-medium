import { useMemo, useSyncExternalStore } from 'react'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command'
import { useActionContext } from '@/shortcuts/useActionContext.js'
import { useRunAction } from '@/shortcuts/runAction.js'
import { useEditModeYieldKeepalive } from '@/components/useEditModeYieldKeepalive.js'
import { actionRuntimeKey } from '@/shortcuts/effectiveActions.js'
import {
  type ActionConfig,
  type ShortcutBinding,
  type ActionContextType,
} from '@/shortcuts/types.js'
import { Kbd } from '@/components/ui/kbd'
import { formatChord } from '@/plugins/keybindings-settings/keyCapture.ts'
import { groupBy } from 'lodash-es'
import { commandPaletteToggle } from './toggleStore.ts'
import { COMMAND_PALETTE_CONTEXT } from './context.ts'
import { useCommandPaletteActions } from './useCommandPaletteActions.ts'

const formatShortcutKeys = (bindings: readonly ShortcutBinding[]): string[] => {
  if (!bindings || bindings.length === 0) {
    return []
  }
  return bindings.flatMap(binding =>
    Array.isArray(binding.keys) ? binding.keys : [binding.keys],
  )
}

export function CommandPalette() {
  const open = useSyncExternalStore(
    commandPaletteToggle.subscribe,
    commandPaletteToggle.isOpen,
    commandPaletteToggle.isOpen,
  )

  const shortcutDependencies = useMemo(() => ({}), [])

  useActionContext(COMMAND_PALETTE_CONTEXT, shortcutDependencies, open)

  // Hold edit mode open (and return focus to the editor on close) when the
  // palette was opened from edit mode — see the hook for the full contract.
  useEditModeYieldKeepalive(open)

  const {actions, activeContexts, bindingsFor} = useCommandPaletteActions()
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
    const logFailure = (error: unknown) =>
      console.error(`[CommandPalette] Failed to execute action: ${actionId}`, error)
    try {
      // `runAction` returns the handler's `void | Promise<void>`. The try/catch
      // only catches a synchronous throw (e.g. resolve failing), so attach a
      // `.catch` to surface an async handler rejection too rather than leaking
      // it as an unhandled rejection.
      void Promise.resolve(
        runAction(actionId, new CustomEvent('command-pallet-trigger')),
      ).catch(logFailure)
    } catch (error) {
      logFailure(error)
    } finally {
      commandPaletteToggle.close()
    }
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={commandPaletteToggle.set}
      contentClassName="top-[12vh] translate-y-0"
    >
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
                const bindings = bindingsFor(action)
                const shortcutKeys = formatShortcutKeys(bindings)
                // cmdk tracks selection by `value`, so it MUST be unique across
                // the whole list, and a bare `action.id` is not: a description
                // can be shared (ArrowUp/ArrowLeft "move to previous block" CM
                // nav), and an id can be shared by distinct actions live in
                // different contexts at once (global `undo`/`redo` + vim
                // normal-mode `undo`/`redo`). A duplicate value makes cmdk
                // highlight both rows and loop arrow-nav between them, so key on
                // the context-qualified runtime key. `keywords` keeps the human
                // group/description text searchable; onSelect runs the bare id.
                const itemKey = actionRuntimeKey(action)
                return (
                  <CommandItem
                    key={itemKey}
                    value={itemKey}
                    keywords={[groupHeading, action.description]}
                    onSelect={() => runCommand(action.id)}
                    className="flex justify-between items-center"
                  >
                    <span>{action.description}</span>
                    {shortcutKeys.length > 0 && (
                      <div className="flex gap-1">
                        {shortcutKeys.map((keyStr, index) => (
                          <Kbd key={index}>{formatChord(keyStr)}</Kbd>
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
