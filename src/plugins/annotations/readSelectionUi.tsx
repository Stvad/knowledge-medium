import {useState, type ReactElement} from 'react'
import type {Block} from '@/data/block'
import {useBlockContext} from '@/context/block.js'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu.js'
import {keepFocusAnItemMoved} from '@/components/renderer/DefaultBlockRenderer.js'
import type {AppMountContribution} from '@/extensions/core.js'
import {useActionContext} from '@/shortcuts/useActionContext.js'
import {
  READ_SELECTION_CONTEXT,
  readSelectionGestures,
  readSelectionTarget,
  reportFailure,
  runOnReadTarget,
  type SelectionTarget,
} from './actions.ts'
import {useHoldsReadSelection} from './readSelection.ts'

const NO_DEPS = {}

const ReadSelectionShortcuts = () => {
  useActionContext(READ_SELECTION_CONTEXT, NO_DEPS)
  return null
}

export const readSelectionShortcutsMount: AppMountContribution = {
  id: 'annotations.read-selection-shortcuts',
  component: ReadSelectionShortcuts,
}

/**
 * The read-mode gestures on a right-click inside a selection in `block`'s
 * content. Anywhere else the browser's own menu shows: the trigger is enabled
 * only while this block holds the selection, and it is always mounted, since
 * mounting it around the content would replace the very text that is
 * selected.
 *
 * The target is read as the menu opens, before focus moves into it.
 */
export const ReadSelectionMenu = ({block, children}: {block: Block; children: ReactElement}) => {
  const {renderScopeId} = useBlockContext()
  const holds = useHoldsReadSelection(block.id, renderScopeId)
  const [target, setTarget] = useState<SelectionTarget | string | null>(null)
  return (
    <ContextMenu onOpenChange={open => setTarget(open ? readSelectionTarget(block.repo, document.getSelection()) : null)}>
      {/* Radix sets a touch-callout of none on its trigger, for a menu of
          its own on long-press; this trigger is the content, which keeps the
          callout its ancestors give it (touch selection turns it off). */}
      <ContextMenuTrigger asChild disabled={!holds} style={{WebkitTouchCallout: 'inherit'}}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-[160px] bg-background rounded-md p-1 shadow-md border border-border"
        onCloseAutoFocus={keepFocusAnItemMoved}
      >
        {readSelectionGestures.map(gesture => (
          <ContextMenuItem
            key={gesture.actionId}
            className="flex cursor-pointer items-center px-2 py-1.5 text-sm outline-none hover:bg-muted rounded-sm"
            onSelect={() => { runOnReadTarget(target, gesture.step).catch(reportFailure) }}
          >
            <gesture.icon className="mr-2 h-4 w-4"/>
            {gesture.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}
