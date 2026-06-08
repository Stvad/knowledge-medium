import { useMemo } from 'react'
import type { MouseEvent } from 'react'
import {
  blockSelectionClickDecoratorsFacet,
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
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { editorAutocompleteExtension } from '@/extensions/editorAutocomplete.js'
import { AppExtension } from '@/extensions/facet.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
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
  // Resolved selection-click handler — the structural base wrapped by any
  // contributed decorators (e.g. spatial navigation's DOM-order range).
  // `runtime.read` caches per-facet, so this reference is stable.
  const applySelectionClick = useAppRuntime().read(blockSelectionClickDecoratorsFacet)
  const nextState = useMemo(
    () => createBlockSelectionShellState(resolveContext, state, applySelectionClick),
    [resolveContext, state, applySelectionClick],
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
