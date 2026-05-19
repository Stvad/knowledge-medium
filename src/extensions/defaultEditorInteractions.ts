import {
  blockShellDecoratorsFacet,
  ShortcutActivationContribution,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'
import { blockFocusShellDecorator } from '@/extensions/blockFocusShellDecorator.ts'

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

export const defaultEditorInteractionExtension: AppExtension = [
  blockShellDecoratorsFacet.of(blockFocusShellDecorator, {
    precedence: 1000,
    source: 'default-block-focus',
  }),
  shortcutSurfaceActivationsFacet.of(codeMirrorEditModeActivation, {
    source: 'codemirror-edit-mode',
  }),
]
