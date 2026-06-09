import { useMemo } from 'react'
import type { MouseEvent } from 'react'
import {
  blockPointerDepsFrom,
  blockShellDecoratorsFacet,
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
import { actionsFacet } from '@/extensions/core.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { dispatchPointerAction } from '@/shortcuts/pointerAction.js'
import {
  extendBlockSelectionAction,
  toggleBlockSelectionAction,
} from '@/extensions/blockSelectionAction.js'
import { blockFocusShellDecorator } from '@/extensions/BlockFocusShellDecorator.js'
import { systemToggle } from '@/extensions/togglable.js'

export const codeMirrorEditModeActivation: ShortcutActivationContribution = context => {
  if (context.surface !== 'codemirror' || !context.editorView) return null
  const renderScopeId = typeof context.blockContext?.renderScopeId === 'string'
    ? context.blockContext.renderScopeId
    : undefined

  return [{
    context: ActionContextTypes.EDIT_MODE_CM,
    dependencies: {
      block: context.block,
      editorView: context.editorView,
      ...(renderScopeId ? {renderScopeId} : {}),
    },
  }]
}

const isBlockSelectionGesture = (event: MouseEvent<HTMLElement>): boolean =>
  isSelectionClick(event) && !isInteractiveContentEvent(event)

export const createBlockSelectionShellState = (
  resolveContext: BlockResolveContext,
  state: BlockShellState,
): BlockShellState => ({
  shellProps: {
    ...state.shellProps,
    onMouseDownCapture: event => {
      if (isBlockSelectionGesture(event)) {
        // Suppress the browser's native text-selection drag a modifier-click
        // would otherwise start before the click resolves. (click-phase
        // pointer actions are too late for this; it stays a mousedown concern.)
        event.preventDefault()
        return
      }
      state.shellProps.onMouseDownCapture?.(event)
    },
    onClick: event => {
      // Every block pointer gesture resolves through one dispatch: shift-click →
      // extend selection, ctrl/cmd-click → toggle, plain click → edit/focus. The
      // block-pointer context's pointerTargetFilter keeps interactive descendants
      // native (no candidate matches). Fall back to any residual facet click
      // handler only when nothing claims the gesture.
      if (!dispatchPointerAction(event, blockPointerDepsFrom(resolveContext, event))) {
        state.shellProps.onClick?.(event)
      }
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
  // Block selection as pointer-bound actions — shift-click extends (spatial
  // navigation decorates it via ActionTransform for visible-DOM-order ranges),
  // ctrl/cmd-click toggles. Both replace the structural handleBlockSelectionClick.
  actionsFacet.of(extendBlockSelectionAction, {source: 'default-block-selection'}),
  actionsFacet.of(toggleBlockSelectionAction, {source: 'default-block-selection'}),
  editorAutocompleteExtension,
])
