import type { MouseEvent, TouchEvent } from 'react'
import {
  BlockClickContribution,
  BlockContentSurfaceContribution,
  enterBlockEditMode,
  handleBlockSelectionClick,
  ShortcutActivationContribution,
} from '@/extensions/blockInteraction.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'

export const vimBlockClickBehavior: BlockClickContribution = context =>
  event => handleBlockSelectionClick(context, event)

type TouchStart = { x: number; y: number; time: number }

const touchStartByBlockId = new Map<string, TouchStart>()

const isTap = (start: TouchStart, end: TouchStart) =>
  Math.abs(end.x - start.x) <= 10 && Math.abs(end.y - start.y) <= 10 && (end.time - start.time) <= 300

export const vimContentSurfaceBehavior: BlockContentSurfaceContribution = context => {
  if (context.inEditMode) return null

  return {
    onMouseDownCapture: (event: MouseEvent) => {
      // detail === 2 catches double-click before native text-selection kicks in
      if (event.detail !== 2) return
      event.preventDefault()
      event.stopPropagation()
      void enterBlockEditMode(context, {x: event.clientX, y: event.clientY})
    },
    onTouchStart: (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) return
      touchStartByBlockId.set(context.block.id, {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      })
    },
    onTouchEnd: (event: TouchEvent) => {
      const start = touchStartByBlockId.get(context.block.id)
      touchStartByBlockId.delete(context.block.id)
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

  return [{
    context: ActionContextTypes.NORMAL_MODE,
    dependencies: {
      block: context.block,
    },
  }]
}
