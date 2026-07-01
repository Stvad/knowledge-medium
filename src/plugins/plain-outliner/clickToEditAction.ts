import type { MouseEvent as ReactMouseEvent } from 'react'
import { enterEditModeForBlock } from '@/extensions/blockInteraction.js'
import { grabSoftKeyboard } from '@/utils/softKeyboardGrab.js'
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
 * selection gestures match the selection actions instead and never reach here.
 *
 * Interactive descendants (links, buttons, …) are excluded by the
 * `block-pointer` context's `pointerTargetFilter`, so this action never sees
 * them and doesn't re-check — that "not my gesture" decision lives once, on the
 * context, rather than in every block pointer action.
 *
 * Lives in the `block-pointer` context: never keyboard-active, dispatched only
 * via the pointer path with the clicked block's deps supplied. Vim normal mode
 * decorates it (via the action-dispatch seam) to focus-without-editing, the same
 * way it used to win the `blockClickHandlersFacet` last-contribution race.
 */
export const enterBlockEditModeOnClickAction: ActionConfig<typeof ActionContextTypes.BLOCK_POINTER> = {
  id: ENTER_BLOCK_EDIT_MODE_ACTION_ID,
  description: 'Enter edit mode on click',
  context: ActionContextTypes.BLOCK_POINTER,
  pointerBinding: {kind: 'mouse', mods: [], phase: 'click'},
  handler: ({block, uiStateBlock, renderScopeId}, trigger: ActionTrigger) => {
    // Surface the soft keyboard NOW, synchronously inside the tap gesture: the
    // editor's own focus lands a frame later (async edit-mode entry + rAF),
    // outside the gesture, and iOS won't raise the keyboard for it — so without
    // this the block enters edit mode but needs a second tap for a keyboard.
    // The editor's later focus transfers seamlessly. See grabSoftKeyboard.
    // Skip in read-only workspaces: no editor will mount (edit mode is gated on
    // !isReadOnly, same as focusBlock), so grabbing would raise a soft keyboard
    // with nothing to type into until the failsafe blurs it. isReadOnly is a
    // sync read, so the gesture-synchronous requirement is preserved.
    if (!uiStateBlock.repo.isReadOnly) grabSoftKeyboard()
    const event = trigger as ReactMouseEvent<HTMLElement>
    void enterEditModeForBlock(block, uiStateBlock, renderScopeId, {
      x: event.clientX,
      y: event.clientY,
    })
  },
}
