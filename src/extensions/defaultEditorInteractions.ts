import { useMemo } from 'react'
import type { MouseEvent } from 'react'
import {
  blockShellDecoratorsFacet,
  handleBlockSelectionClick,
  isInteractiveContentEvent,
  isSelectionClick,
  type BlockResolveContext,
  type BlockShellDecoratorContribution,
  type BlockShellDecoratorProps,
  type BlockShellState,
  ShortcutActivationContribution,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.js'
import { editorAutocompleteExtension } from '@/extensions/editorAutocomplete.js'
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

type ApplyBlockSelectionClick = (
  context: BlockResolveContext,
  event: MouseEvent<HTMLElement>,
) => void | Promise<void>

const isBlockSelectionGesture = (event: MouseEvent<HTMLElement>): boolean =>
  isSelectionClick(event) && !isInteractiveContentEvent(event)

export const createBlockSelectionShellState = (
  resolveContext: BlockResolveContext,
  state: BlockShellState,
  applySelectionClick: ApplyBlockSelectionClick = handleBlockSelectionClick,
): BlockShellState => ({
  shellProps: {
    ...state.shellProps,
    onMouseDownCapture: event => {
      if (isBlockSelectionGesture(event)) {
        event.preventDefault()
        return
      }
      state.shellProps.onMouseDownCapture?.(event)
    },
    onClick: event => {
      if (isBlockSelectionGesture(event)) {
        void applySelectionClick(resolveContext, event)
        return
      }
      state.shellProps.onClick?.(event)
    },
  },
  shortcutSurfaceOptions: state.shortcutSurfaceOptions,
})

export function BlockSelectionShellDecorator({
  resolveContext,
  state,
  children,
}: BlockShellDecoratorProps) {
  const nextState = useMemo(
    () => createBlockSelectionShellState(resolveContext, state),
    [resolveContext, state],
  )

  return children(nextState)
}

export const blockSelectionShellDecorator: BlockShellDecoratorContribution = () =>
  BlockSelectionShellDecorator

export const defaultEditorInteractionExtension: AppExtension = systemToggle({
  id: 'system:default-editor-interactions',
  name: 'Default editor interactions',
  description: 'Baseline block-interaction handlers (click-to-edit, selection, focus transitions).',
  essential: true,
}).of([
  blockShellDecoratorsFacet.of(blockSelectionShellDecorator, {source: 'default-block-selection'}),
  blockShellDecoratorsFacet.of(blockFocusShellDecorator, {
    precedence: 1000,
    source: 'default-block-focus',
  }),
  shortcutSurfaceActivationsFacet.of(codeMirrorEditModeActivation, {
    source: 'codemirror-edit-mode',
  }),
  editorAutocompleteExtension,
])
