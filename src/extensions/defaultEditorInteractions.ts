import {
  blockShellDecoratorsFacet,
  ShortcutActivationContribution,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.js'
import { AppExtension } from '@/extensions/facet.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { blockFocusShellDecorator } from '@/extensions/BlockFocusShellDecorator.js'
import { systemToggle } from '@/extensions/togglable.js'

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

export const defaultEditorInteractionExtension: AppExtension = systemToggle({
  id: 'system:default-editor-interactions',
  name: 'Default editor interactions',
  description: 'Baseline block-interaction handlers (click-to-edit, selection, focus transitions).',
  essential: true,
}).of([
  blockShellDecoratorsFacet.of(blockFocusShellDecorator, {
    precedence: 1000,
    source: 'default-block-focus',
  }),
  shortcutSurfaceActivationsFacet.of(codeMirrorEditModeActivation, {
    source: 'codemirror-edit-mode',
  }),
])
