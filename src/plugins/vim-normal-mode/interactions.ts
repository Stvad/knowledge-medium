import type { MouseEvent, TouchEvent } from 'react'
import {
  BlockClickContribution,
  BlockContentSurfaceContribution,
  enterBlockEditMode,
  handleBlockSelectionClick,
  isInteractiveContentEvent,
  isSelectionClick,
  ShortcutActivationContribution,
} from '@/extensions/blockInteraction.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { isEditingProp, isFocusedBlock } from '@/data/properties.js'
import { Block } from '../../data/block'

export const vimBlockClickBehavior: BlockClickContribution = context =>
  event => {
    if (isSelectionClick(event)) return
    void handleBlockSelectionClick(context, event)
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
