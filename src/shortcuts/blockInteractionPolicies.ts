import type { MouseEvent } from 'react'
import {
  BlockClickContribution,
  BlockContentRendererContribution,
  enterBlockEditMode,
  getBlockContentRendererSlot,
  handleBlockSelectionClick,
  isSelectionClick,
  ShortcutActivationContribution,
  blockClickHandlersFacet,
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
  shortcutSurfaceActivationsFacet.of(codeMirrorEditModeActivation, {
    source: 'codemirror-edit-mode',
  }),
]
