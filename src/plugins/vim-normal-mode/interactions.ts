import type { MouseEvent, TouchEvent } from 'react'
import {
  BlockClickContribution,
  BlockContentGestureContribution,
  enterBlockEditMode,
  handleBlockSelectionClick,
  ShortcutActivationContribution,
} from '@/extensions/blockInteraction.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'

export const vimBlockClickBehavior: BlockClickContribution = context =>
  event => handleBlockSelectionClick(context, event)

export const vimContentGestureBehavior: BlockContentGestureContribution = context => ({
  onDoubleClick: async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    await enterBlockEditMode(context, {
      x: event.clientX,
      y: event.clientY,
    })
  },
  onTap: async (event: TouchEvent) => {
    event.preventDefault()
    event.stopPropagation()

    const touch = event.changedTouches[0]
    await enterBlockEditMode(context, touch
      ? {x: touch.clientX, y: touch.clientY}
      : undefined)
  },
})

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
