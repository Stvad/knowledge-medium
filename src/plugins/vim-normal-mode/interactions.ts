import type { MouseEvent, MouseEvent as ReactMouseEvent, TouchEvent } from 'react'
import {
  BlockContentSurfaceContribution,
  enterBlockEditMode,
  focusBlockWithoutEditing,
  isInteractiveContentEvent,
  ShortcutActivationContribution,
} from '@/extensions/blockInteraction.js'
import {
  ActionContextTypes,
  type ActionTransform,
  type ActionTrigger,
  type BlockPointerDependencies,
} from '@/shortcuts/types.js'
import { isEditingProp, isFocusedBlock } from '@/data/properties.js'
import { ENTER_BLOCK_EDIT_MODE_ACTION_ID } from '@/plugins/plain-outliner/clickToEditAction.js'
import { Block } from '../../data/block'

/**
 * Vim normal mode: a single click focuses the block instead of entering edit
 * mode (double-click / tap still edits — see `vimContentSurfaceBehavior`).
 *
 * Decorates the plain-outliner click-to-edit pointer action by replacing its
 * handler, the same Replace semantics vim used to get by winning the
 * `blockClickHandlersFacet` last-contribution race — now expressed through the
 * one transform mechanism. Declines on interactive content so links/buttons
 * fall through to native handling.
 */
export const vimClickToFocusTransform: ActionTransform = {
  actionId: ENTER_BLOCK_EDIT_MODE_ACTION_ID,
  context: ActionContextTypes.BLOCK_POINTER,
  apply: action => ({
    ...action,
    handler: (deps, trigger: ActionTrigger) => {
      const event = trigger as ReactMouseEvent<HTMLElement>
      if (isInteractiveContentEvent(event)) return false
      const {block, uiStateBlock, renderScopeId} = deps as BlockPointerDependencies
      void focusBlockWithoutEditing(block, uiStateBlock, renderScopeId)
    },
  }),
}

type TouchStart = { x: number; y: number; time: number }

const touchStartByBlockId = new Map<string, TouchStart>()

const isTap = (start: TouchStart, end: TouchStart) =>
  Math.abs(end.x - start.x) <= 10 && Math.abs(end.y - start.y) <= 10 && (end.time - start.time) <= 300

const isBlockInEditMode = (uiStateBlock: Block, blockId: string, renderScopeId?: string): boolean =>
  isFocusedBlock(uiStateBlock, blockId, renderScopeId) &&
  Boolean(uiStateBlock.peekProperty(isEditingProp))

export const vimContentSurfaceBehavior: BlockContentSurfaceContribution = context => {
  const {block, uiStateBlock} = context
  const renderScopeId = typeof context.blockContext?.renderScopeId === 'string'
    ? context.blockContext.renderScopeId
    : undefined

  return {
    onMouseDownCapture: (event: MouseEvent) => {
      if (event.defaultPrevented) return
      if (isInteractiveContentEvent(event)) return
      if (isBlockInEditMode(uiStateBlock, block.id, renderScopeId)) return
      // detail === 2 catches double-click before native text-selection kicks in
      if (event.detail !== 2) return
      event.preventDefault()
      event.stopPropagation()
      void enterBlockEditMode(context, {x: event.clientX, y: event.clientY})
    },
    onTouchStart: (event: TouchEvent) => {
      if (isInteractiveContentEvent(event)) {
        touchStartByBlockId.delete(block.id)
        return
      }
      if (isBlockInEditMode(uiStateBlock, block.id, renderScopeId)) return
      const touch = event.touches[0]
      if (!touch) return
      touchStartByBlockId.set(block.id, {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      })
    },
    onTouchEnd: (event: TouchEvent) => {
      if (isInteractiveContentEvent(event)) {
        touchStartByBlockId.delete(block.id)
        return
      }
      if (isBlockInEditMode(uiStateBlock, block.id, renderScopeId)) return
      const start = touchStartByBlockId.get(block.id)
      touchStartByBlockId.delete(block.id)
      const touch = event.changedTouches[0]
      if (!start || !touch) return

      const end = {x: touch.clientX, y: touch.clientY, time: Date.now()}
      if (!isTap(start, end)) return

      event.preventDefault()
      event.stopPropagation()
      void enterBlockEditMode(context, {x: touch.clientX, y: touch.clientY})
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
