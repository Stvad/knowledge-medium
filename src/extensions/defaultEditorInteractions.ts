import { useMemo } from 'react'
import type { MouseEvent, TouchEvent } from 'react'
import {
  blockContentSurfacePropsFacet,
  blockPointerDepsFrom,
  blockShellDecoratorsFacet,
  isInteractiveContentEvent,
  isSelectionClick,
  type BlockContentSurfaceContribution,
  type BlockResolveContext,
  type BlockShellDecoratorContribution,
  type BlockShellDecoratorProps,
  type BlockShellState,
  ShortcutActivationContribution,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.js'
import { editorAutocompleteExtension } from '@/extensions/editorAutocomplete.js'
import { AppExtension } from '@/facets/facet.js'
import { actionsFacet } from '@/extensions/core.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { dispatchPointerAction, type PointerGestureEvent } from '@/shortcuts/pointerAction.js'
import {
  extendBlockSelectionAction,
  toggleBlockSelectionAction,
} from '@/extensions/blockSelectionAction.js'
import { blockFocusShellDecorator } from '@/extensions/BlockFocusShellDecorator.js'
import { systemToggle } from '@/facets/togglable.js'

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

type ContentTouchStart = { x: number; y: number; time: number }

// Per-block touch origin, kept between touchstart and touchend so a tap can be
// told apart from a drag/scroll. Module-level because the surface contribution
// is re-derived per render; keyed by block id, cleared on every touchend.
const contentTouchStarts = new Map<string, ContentTouchStart>()

const TAP_MOVE_PX = 10
const TAP_MAX_MS = 300

const isTap = (start: ContentTouchStart, end: ContentTouchStart): boolean =>
  Math.abs(end.x - start.x) <= TAP_MOVE_PX &&
  Math.abs(end.y - start.y) <= TAP_MOVE_PX &&
  (end.time - start.time) <= TAP_MAX_MS

/**
 * Core pointer-gesture recognition on a block's CONTENT surface: routes a
 * pointerdown-phase mouse gesture and a touch tap through the same pointer
 * dispatch the shell uses for clicks, with the block's deps supplied. The
 * surface only RECOGNISES and routes; what a gesture DOES is a bound
 * `block-pointer` action (e.g. vim's double-click/tap-to-edit), so an unbound
 * gesture is a no-op.
 *
 * Lives on the content surface, not the shell, so it never fires for the
 * bullet, controls, or properties chrome — only the block's own content — and
 * the context's `pointerTargetFilter` keeps it off interactive descendants and
 * the CodeMirror editor while editing (where a double-click should select a
 * word natively).
 *
 * Each branch recognises a discrete gesture, then routes it. A multi-click
 * (`detail >= 2`) is the mouse gesture worth routing at the pointerdown phase —
 * the action's binding picks the exact count (`detail: 2` for double-click),
 * and binding at pointerdown (not `click`) lets the dispatch's preventDefault
 * beat native word-selection. A single press isn't a gesture, so it's left for
 * the shell's click. Touch has no single "tap" event, so the tap is recognised
 * here (movement/duration thresholds) before routing.
 */
export const blockContentPointerGestures: BlockContentSurfaceContribution = context => {
  const dispatchGesture = (event: PointerGestureEvent): void => {
    dispatchPointerAction(event, blockPointerDepsFrom(context, event))
  }

  return {
    onMouseDownCapture: (event: MouseEvent<HTMLDivElement>) => {
      // A shell-level selection gesture already preventDefaulted (capture runs
      // shell → content), so skip it here rather than double-routing.
      if (event.defaultPrevented) return
      // Only multi-clicks are pointerdown gestures; a single press is the
      // shell's click to resolve, not a gesture to route.
      if (event.detail < 2) return
      dispatchGesture(event)
    },
    onTouchStart: (event: TouchEvent<HTMLDivElement>) => {
      const touch = event.touches[0]
      if (!touch) return
      contentTouchStarts.set(context.block.id, {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      })
    },
    onTouchEnd: (event: TouchEvent<HTMLDivElement>) => {
      const start = contentTouchStarts.get(context.block.id)
      contentTouchStarts.delete(context.block.id)
      const touch = event.changedTouches[0]
      if (!start || !touch) return
      if (!isTap(start, {x: touch.clientX, y: touch.clientY, time: Date.now()})) return
      dispatchGesture(event)
    },
  }
}

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
  // Content-surface pointer gestures the shell click can't see — pointerdown
  // (double-click) and touch tap — dispatched through the same pointer path.
  blockContentSurfacePropsFacet.of(blockContentPointerGestures, {
    source: 'default-content-gestures',
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
