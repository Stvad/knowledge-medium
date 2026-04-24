import type { MouseEvent, TouchEvent } from 'react'
import {
  BlockClickContribution,
  BlockContentGestureContribution,
  BlockContentRendererContribution,
  enterBlockEditMode,
  getBlockContentRendererSlot,
  handleBlockSelectionClick,
  isSelectionClick,
  ShortcutActivationContribution,
  blockClickHandlersFacet,
  blockContentGestureHandlersFacet,
  blockContentRendererFacet,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'

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

export const textareaEditModeActivation: ShortcutActivationContribution = context => {
  if (context.surface !== 'textarea' || !context.textarea) return null

  return [{
    context: ActionContextTypes.EDIT_MODE,
    dependencies: {
      block: context.block,
      textarea: context.textarea,
    },
  }]
}

export const codeMirrorEditModeActivation: ShortcutActivationContribution = context => {
  if (context.surface !== 'codemirror' || !context.editorView) return null

  return [{
    context: ActionContextTypes.EDIT_MODE_CM,
    dependencies: {
      block: context.block,
      editorView: context.editorView,
    },
  }]
}

export const plainOutlinerInteractionExtension: AppExtension = [
  blockContentRendererFacet.of(blockEditingContentRenderer, {
    source: 'block-editing-content-renderer',
  }),
  blockClickHandlersFacet.of(plainOutlinerBlockClickBehavior, {
    source: 'plain-outliner',
  }),
  shortcutSurfaceActivationsFacet.of(textareaEditModeActivation, {
    source: 'textarea-edit-mode',
  }),
  shortcutSurfaceActivationsFacet.of(codeMirrorEditModeActivation, {
    source: 'codemirror-edit-mode',
  }),
]

export const vimNormalModeInteractionExtension: AppExtension = [
  blockClickHandlersFacet.of(vimBlockClickBehavior, {
    precedence: 100,
    source: 'vim-normal-mode',
  }),
  blockContentGestureHandlersFacet.of(vimContentGestureBehavior, {
    precedence: 100,
    source: 'vim-normal-mode',
  }),
  shortcutSurfaceActivationsFacet.of(vimNormalModeActivation, {
    precedence: 100,
    source: 'vim-normal-mode',
  }),
]
