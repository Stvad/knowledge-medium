import type { MouseEvent } from 'react'
import {
  BlockClickContribution,
  BlockContentRendererContribution,
  enterBlockEditMode,
  getBlockContentRendererSlot,
  handleBlockSelectionClick,
  isSelectionClick,
} from '@/extensions/blockInteraction.ts'

export const blockEditingContentRenderer: BlockContentRendererContribution = context =>
  context.inEditMode
    ? getBlockContentRendererSlot(context, 'secondary') ?? getBlockContentRendererSlot(context, 'primary')
    : getBlockContentRendererSlot(context, 'primary')

export const plainOutlinerBlockClickBehavior: BlockClickContribution = context =>
  async (event: MouseEvent) => {
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
  }
