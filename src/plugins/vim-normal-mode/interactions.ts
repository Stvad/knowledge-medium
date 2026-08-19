import {
  enterEditModeForBlock,
  focusBlockWithoutEditing,
  ShortcutActivationContribution,
  type EditorActivationSelection,
} from '@/extensions/blockInteraction.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionTrigger,
  type BlockPointerDependencies,
} from '@/shortcuts/types.js'
import type { ActionDispatchDecorator } from '@/shortcuts/actionDispatch.js'
import { ENTER_BLOCK_EDIT_MODE_ACTION_ID } from '@/plugins/plain-outliner/clickToEditAction.js'

/**
 * Vim normal mode: a single click focuses the block instead of entering edit
 * mode (double-click / tap still edits — see `enterBlockEditModeOnGestureAction`).
 *
 * Wraps the plain-outliner click-to-edit pointer action at DISPATCH time,
 * replacing its behaviour (it never calls `next`) — the same Replace semantics
 * vim used to get by winning the `blockClickHandlersFacet` last-contribution
 * race, now expressed through the action-dispatch seam rather than an
 * `actionTransformsFacet` handler rewrite. Interactive descendants are excluded
 * upstream by the `block-pointer` context's `pointerTargetFilter`, so the
 * handler doesn't re-check them.
 *
 * Coupling note: this targets plain-outliner's action id, so single-click-focus
 * only applies when plain-outliner is enabled (it provides the click-to-edit
 * action this replaces). That's the normal config — vim normal mode edits the
 * text blocks plain-outliner renders — but disabling plain-outliner while vim
 * stays on would drop click-to-focus rather than fall back to it.
 */
export const vimClickToFocusDecorator: ActionDispatchDecorator = {
  actionId: ENTER_BLOCK_EDIT_MODE_ACTION_ID,
  context: ActionContextTypes.BLOCK_POINTER,
  wrap: (deps) => {
    const {block, uiStateBlock, renderScopeId} = deps as BlockPointerDependencies
    void focusBlockWithoutEditing(block, uiStateBlock, renderScopeId)
  },
}

export const ENTER_BLOCK_EDIT_MODE_GESTURE_ACTION_ID = 'vim.block.enter-edit-mode-gesture'

/** Cursor position for the entered editor, taken from whichever gesture fired:
 *  a tap's changed touch, or a mouse event's client coordinates. Other trigger
 *  shapes (keyboard, custom) carry no position, so editing starts at the
 *  default caret. */
const pointerSelectionFromTrigger = (
  trigger: ActionTrigger,
): EditorActivationSelection | undefined => {
  if ('changedTouches' in trigger) {
    const touch = trigger.changedTouches[0]
    return touch ? {x: touch.clientX, y: touch.clientY} : undefined
  }
  if ('clientX' in trigger) return {x: trigger.clientX, y: trigger.clientY}
  return undefined
}

/**
 * Vim normal mode: a double-click (mouse) or tap (touch) enters edit mode — the
 * counterpart to `vimClickToFocusDecorator`, which makes a single click focus
 * rather than edit. A pointer-bound `block-pointer` action, so it dispatches
 * through the same `resolve` + coordinator path as click-to-edit and selection,
 * with the block's deps SUPPLIED. The gesture is RECOGNISED and routed by core's
 * `blockContentPointerGestures` content-surface contribution; this plugin only
 * contributes what the gesture does (enter edit mode) as a bound action.
 *
 * The double-click binds at `pointerdown` (not `click`) so the dispatch's
 * preventDefault beats the browser's native word-selection; the tap binds at the
 * touch `tap` phase. In a non-vim config nothing binds these gestures, so the
 * core surface routes them and they no-op — single click already edits there.
 */
export const enterBlockEditModeOnGestureAction: ActionConfig<typeof ActionContextTypes.BLOCK_POINTER> = {
  id: ENTER_BLOCK_EDIT_MODE_GESTURE_ACTION_ID,
  description: 'Enter edit mode on double-click or tap',
  context: ActionContextTypes.BLOCK_POINTER,
  pointerBinding: [
    {kind: 'mouse', detail: 2, phase: 'pointerdown'},
    {kind: 'touch', phase: 'tap'},
  ],
  handler: ({block, uiStateBlock, renderScopeId}, trigger) => {
    void enterEditModeForBlock(
      block,
      uiStateBlock,
      renderScopeId,
      pointerSelectionFromTrigger(trigger),
    )
  },
}

export const vimNormalModeActivation: ShortcutActivationContribution = context => {
  if (context.surface !== 'block' || !context.inFocus || context.inEditMode || context.isSelected) {
    return null
  }
  const renderScopeId = typeof context.blockContext?.renderScopeId === 'string'
    ? context.blockContext.renderScopeId
    : undefined

  return [{
    context: ActionContextTypes.NORMAL_MODE,
    dependencies: {
      block: context.block,
      ...(renderScopeId ? {renderScopeId} : {}),
    },
  }]
}
