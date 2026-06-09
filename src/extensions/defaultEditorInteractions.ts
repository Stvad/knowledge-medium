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
import { actionsFacet } from '@/extensions/core.js'
import { ActionContextTypes, type BlockPointerDependencies } from '@/shortcuts/types.js'
import { dispatchPointerAction } from '@/shortcuts/pointerAction.js'
import { extendBlockSelectionAction } from '@/extensions/blockSelectionAction.js'
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

/**
 * Build the deps a pointer-dispatched block gesture needs from a block's
 * resolve context plus the live event. `currentTarget` — the block shell the
 * spatial walker tags — is captured synchronously before React nulls it.
 */
const suppliedPointerDeps = (
  resolveContext: BlockResolveContext,
  event: MouseEvent<HTMLElement>,
): BlockPointerDependencies => {
  const renderScopeId = typeof resolveContext.blockContext?.renderScopeId === 'string'
    ? resolveContext.blockContext.renderScopeId
    : undefined
  return {
    block: resolveContext.block,
    uiStateBlock: resolveContext.uiStateBlock,
    scopeRootId: resolveContext.scopeRootId,
    scopeRootForcesOpen: !resolveContext.blockContext?.isNestedSurface,
    targetElement: event.currentTarget,
    ...(renderScopeId ? {renderScopeId} : {}),
  }
}

/**
 * Dispatch a selection-gesture click through the unified pointer path. A
 * pointer-bound action (shift-click → `extend_block_selection`, possibly
 * decorated by spatial nav) may claim it; if none does (ctrl/meta toggle, plain
 * reset), fall back to the structural handler that still owns those branches.
 */
const dispatchSelectionClick = (
  resolveContext: BlockResolveContext,
  event: MouseEvent<HTMLElement>,
): void => {
  if (!dispatchPointerAction(event, suppliedPointerDeps(resolveContext, event))) {
    void handleBlockSelectionClick(resolveContext, event)
  }
}

export const createBlockSelectionShellState = (
  resolveContext: BlockResolveContext,
  state: BlockShellState,
): BlockShellState => ({
  shellProps: {
    ...state.shellProps,
    onMouseDownCapture: event => {
      if (isBlockSelectionGesture(event)) {
        // Suppress the browser's native text-selection drag a shift-click
        // would otherwise start before the click resolves.
        event.preventDefault()
        return
      }
      state.shellProps.onMouseDownCapture?.(event)
    },
    onClick: event => {
      if (isBlockSelectionGesture(event)) {
        dispatchSelectionClick(resolveContext, event)
        return
      }
      // Interactive descendants (links, buttons, …) keep their native behavior.
      // Pointer actions match on button + modifiers alone and don't re-check the
      // target, so a Shift-click on a link would otherwise be claimed as block
      // selection (extend_block_selection) and preventDefault'd — bypass pointer
      // dispatch entirely here, as the pre-migration click handlers did.
      if (isInteractiveContentEvent(event)) {
        state.shellProps.onClick?.(event)
        return
      }
      // Plain (un-modified) click: route through the unified pointer dispatch
      // so click-to-edit (plain-outliner, vim-decorated) resolves the same way
      // selection gestures do. Falls back to any remaining facet click handler
      // when no pointer action claims the gesture.
      if (!dispatchPointerAction(event, suppliedPointerDeps(resolveContext, event))) {
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
  // Shift-click selection as a pointer-bound action — spatial navigation
  // decorates it (ActionTransform) for visible-DOM-order ranges, mirroring how
  // it decorates the keyboard extend-selection actions.
  actionsFacet.of(extendBlockSelectionAction, {source: 'default-block-selection'}),
  editorAutocompleteExtension,
])
