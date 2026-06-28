import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
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
import { useActiveContextsState, editorViewFromActiveContexts } from '@/shortcuts/ActiveContexts.js'
import { acquireEditModeKeepalive } from '@/components/editModeKeepalive.js'
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

  // Read the live active-contexts map through a ref so the open effect below
  // can sample it at open time without re-running on every activation change
  // (it's keyed on `open` alone).
  const active = useActiveContextsState()
  const activeRef = useRef(active)
  useLayoutEffect(() => {
    activeRef.current = active
  }, [active])

  // Keep the underlying editor in edit mode while the palette is open IF it was
  // opened from edit mode. Opening the palette moves focus into its input,
  // which would otherwise trip BlockEditor's exit-on-blur and deactivate the
  // EDIT_MODE_CM context — leaving the palette unable to list or run edit
  // commands (and, with vim normal mode off, no block context at all). A
  // 'yield-focus' keepalive holds edit mode without pulling focus back from the
  // palette; on close we hand focus to the editor we kept alive. Acquired in a
  // layout effect so it lands before the blur's deferred rAF decision fires.
  useLayoutEffect(() => {
    if (!open) return
    const editorView = editorViewFromActiveContexts(activeRef.current)
    if (!editorView) return // opened from normal mode / not editing — nothing to keep alive
    const release = acquireEditModeKeepalive('yield-focus')
    return () => {
      // Palette closing: hand focus back to the editor we kept in edit mode —
      // but only if it's STILL the active edit context and mounted. A command
      // run from the palette may have moved focus to another block or unmounted
      // this editor; refocusing a stale view would steal focus from the command,
      // and focus() on a torn-down view can throw (no `destroyed` guard in CM).
      const liveView = editorViewFromActiveContexts(activeRef.current)
      if (liveView === editorView && editorView.dom.isConnected) editorView.focus()
      release()
    }
  }, [open])

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
