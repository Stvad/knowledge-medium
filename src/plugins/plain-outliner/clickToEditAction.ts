import type { MouseEvent as ReactMouseEvent } from 'react'
import {
  enterEditModeForBlock,
  isInteractiveContentEvent,
} from '@/extensions/blockInteraction.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionTrigger,
} from '@/shortcuts/types.js'

export const ENTER_BLOCK_EDIT_MODE_ACTION_ID = 'block.enter-edit-mode'

/**
 * Click-to-edit as a pointer-bound action: a plain (un-modified) click on a
 * block's shell enters edit mode at the click position. The pointer binding's
 * exact-modifier match means it only fires on a bare click — ctrl/meta/shift
 * selection gestures match the selection action instead and never reach here.
 *
 * Declines (returns `false`) on clicks landing inside interactive content
 * (links, buttons, …) so those fall through to native handling — the "this is
 * not my gesture" contract the unified dispatch relies on, replacing the
 * plain-outliner click handler's early `return`.
 *
 * Lives in the `block-pointer` context: never keyboard-active, dispatched only
 * via the pointer path with the clicked block's deps supplied. Vim normal mode
 * decorates it (an `ActionTransform`) to focus-without-editing, the same way it
 * used to win the `blockClickHandlersFacet` last-contribution race.
 */
export const enterBlockEditModeOnClickAction: ActionConfig<typeof ActionContextTypes.BLOCK_POINTER> = {
  id: ENTER_BLOCK_EDIT_MODE_ACTION_ID,
  description: 'Enter edit mode on click',
  context: ActionContextTypes.BLOCK_POINTER,
  pointerBinding: {kind: 'mouse', mods: [], phase: 'click'},
  handler: ({block, uiStateBlock, renderScopeId}, trigger: ActionTrigger) => {
    const event = trigger as ReactMouseEvent<HTMLElement>
    if (isInteractiveContentEvent(event)) return false
    void enterEditModeForBlock(block, uiStateBlock, renderScopeId, {
      x: event.clientX,
      y: event.clientY,
    })
  },
}
