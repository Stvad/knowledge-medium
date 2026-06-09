import type { MouseEvent, TouchEvent } from 'react'
import {
  blockPointerDepsFrom,
  BlockContentSurfaceContribution,
  enterEditModeForBlock,
  focusBlockWithoutEditing,
  ShortcutActivationContribution,
  type EditorActivationSelection,
} from '@/extensions/blockInteraction.js'
import {
  dispatchPointerAction,
  type PointerGestureEvent,
} from '@/shortcuts/pointerAction.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionTransform,
  type ActionTrigger,
  type BlockPointerDependencies,
} from '@/shortcuts/types.js'
import { isEditingProp, isFocusedBlock } from '@/data/properties.js'
import { ENTER_BLOCK_EDIT_MODE_ACTION_ID } from '@/plugins/plain-outliner/clickToEditAction.js'
import { Block } from '../../data/block'

/**
 * Vim normal mode: a single click focuses the block instead of entering edit
 * mode (double-click / tap still edits — see `enterBlockEditModeOnGestureAction`).
 *
 * Decorates the plain-outliner click-to-edit pointer action by replacing its
 * handler, the same Replace semantics vim used to get by winning the
 * `blockClickHandlersFacet` last-contribution race — now expressed through the
 * one transform mechanism. Interactive descendants are excluded upstream by the
 * `block-pointer` context's `pointerTargetFilter`, so the handler doesn't
 * re-check them.
 *
 * Coupling note: this targets plain-outliner's action id, so single-click-focus
 * only applies when plain-outliner is enabled (it provides the click-to-edit
 * action this replaces). That's the normal config — vim normal mode edits the
 * text blocks plain-outliner renders — but disabling plain-outliner while vim
 * stays on would drop click-to-focus rather than fall back to it.
 */
export const vimClickToFocusTransform: ActionTransform = {
  actionId: ENTER_BLOCK_EDIT_MODE_ACTION_ID,
  context: ActionContextTypes.BLOCK_POINTER,
  apply: action => ({
    ...action,
    handler: (deps) => {
      const {block, uiStateBlock, renderScopeId} = deps as BlockPointerDependencies
      void focusBlockWithoutEditing(block, uiStateBlock, renderScopeId)
    },
  }),
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
 * counterpart to `vimClickToFocusTransform`, which makes a single click focus
 * rather than edit. A pointer-bound `block-pointer` action, so it dispatches
 * through the same `resolve` + coordinator path as click-to-edit and selection,
 * with the clicked/tapped block's deps SUPPLIED. The context's
 * `pointerTargetFilter` keeps it off interactive descendants and the CodeMirror
 * editor (once editing, the surface is contenteditable → filtered → native
 * double-click word-select stands).
 *
 * Double-click binds at `pointerdown` to beat the browser's native
 * text-selection, which the `click` phase is too late to suppress; the tap
 * binds at the touch `tap` phase, dispatched from the content surface's
 * touchend once it has recognised the gesture.
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

type TouchStart = { x: number; y: number; time: number }

const touchStartByBlockId = new Map<string, TouchStart>()

const isTap = (start: TouchStart, end: TouchStart) =>
  Math.abs(end.x - start.x) <= 10 && Math.abs(end.y - start.y) <= 10 && (end.time - start.time) <= 300

const isBlockInEditMode = (uiStateBlock: Block, blockId: string, renderScopeId?: string): boolean =>
  isFocusedBlock(uiStateBlock, blockId, renderScopeId) &&
  Boolean(uiStateBlock.peekProperty(isEditingProp))

/**
 * Recognises the double-click and tap gestures on a block's content surface and
 * dispatches them through the pointer path; what they DO (enter edit mode) lives
 * in `enterBlockEditModeOnGestureAction`, decoratable like any other action.
 * Interactive-target and edit-mode exclusion are the block-pointer context's
 * job (`pointerTargetFilter`), so this only recognises the gesture and routes
 * it. The dispatch path applies preventDefault/stopPropagation when an action
 * handles the gesture — which suppresses the synthetic click a tap would
 * otherwise raise (a single click focuses in vim, so an un-suppressed tap would
 * focus instead of edit).
 */
export const vimContentSurfaceBehavior: BlockContentSurfaceContribution = context => {
  const {block, uiStateBlock} = context
  const renderScopeId = typeof context.blockContext?.renderScopeId === 'string'
    ? context.blockContext.renderScopeId
    : undefined

  const dispatchGesture = (event: PointerGestureEvent): void => {
    dispatchPointerAction(event, blockPointerDepsFrom(context, event))
  }

  return {
    onMouseDownCapture: (event: MouseEvent<HTMLElement>) => {
      if (event.defaultPrevented) return
      if (isBlockInEditMode(uiStateBlock, block.id, renderScopeId)) return
      // detail === 2 catches the double-click before native text-selection kicks
      // in; it dispatches at the pointerdown phase to beat that selection.
      if (event.detail !== 2) return
      dispatchGesture(event)
    },
    onTouchStart: (event: TouchEvent<HTMLElement>) => {
      if (isBlockInEditMode(uiStateBlock, block.id, renderScopeId)) {
        touchStartByBlockId.delete(block.id)
        return
      }
      const touch = event.touches[0]
      if (!touch) return
      touchStartByBlockId.set(block.id, {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      })
    },
    onTouchEnd: (event: TouchEvent<HTMLElement>) => {
      const start = touchStartByBlockId.get(block.id)
      touchStartByBlockId.delete(block.id)
      if (isBlockInEditMode(uiStateBlock, block.id, renderScopeId)) return
      const touch = event.changedTouches[0]
      if (!start || !touch) return

      const end = {x: touch.clientX, y: touch.clientY, time: Date.now()}
      if (!isTap(start, end)) return

      dispatchGesture(event)
    },
  }
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
