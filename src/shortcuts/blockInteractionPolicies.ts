import type { MouseEvent, TouchEvent } from 'react'
import {
  BlockInteractionPolicyExtension,
  enterBlockEditMode,
  handleBlockSelectionClick,
  isSelectionClick,
} from '@/extensions/blockInteraction.ts'

export const plainOutlinerBlockInteractionPolicy: BlockInteractionPolicyExtension = context => ({
  contentMode: context.inEditMode ? 'editor' : 'preview',
  activateNormalMode: false,
  handleBlockClick: async (event: MouseEvent) => {
    if (isSelectionClick(event)) {
      await handleBlockSelectionClick(context, event)
      return
    }

    event.preventDefault()
    event.stopPropagation()

    await enterBlockEditMode(context, {
      x: event.clientX,
      y: event.clientY,
    })
  },
})

export const vimBlockInteractionPolicy: BlockInteractionPolicyExtension = context => ({
  contentMode: context.inEditMode ? 'editor' : 'preview',
  activateNormalMode: context.inFocus && !context.inEditMode && !context.isSelected,
  handleBlockClick: event => handleBlockSelectionClick(context, event),
  handleContentDoubleClick: async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    await enterBlockEditMode(context, {
      x: event.clientX,
      y: event.clientY,
    })
  },
  handleContentTap: async (event: TouchEvent) => {
    event.preventDefault()
    event.stopPropagation()

    const touch = event.changedTouches[0]
    await enterBlockEditMode(context, touch
      ? {x: touch.clientX, y: touch.clientY}
      : undefined)
  },
})
