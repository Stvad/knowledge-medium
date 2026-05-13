import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import {
  IndentDecrease,
  IndentIncrease,
  ArrowUp,
  ArrowDown,
  Undo2,
  Redo2,
  KeyboardOff,
} from 'lucide-react'
import { useIsMobile } from '@/utils/react.tsx'
import { useRunAction } from '@/shortcuts/runAction.ts'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts.tsx'
import { ActionContextTypes, type CodeMirrorEditModeDependencies } from '@/shortcuts/types.ts'
import {
  acquireBlurExitSuppression,
  scheduleBlurExitSuppressionRelease,
} from '@/utils/editorFocus.ts'
import {
  INSERT_BLOCK_REF_TRIGGER_ACTION_ID,
  INSERT_PAGE_REF_TRIGGER_ACTION_ID,
} from './actions.ts'

type ToolbarAction = {
  kind: 'icon'
  id: string
  actionId: string
  label: string
  icon: typeof IndentDecrease
} | {
  kind: 'text'
  id: string
  actionId: string
  label: string
  text: string
}

const EXIT_EDIT_ACTION_ID = 'exit_edit_mode_cm'

const TOOLBAR_ACTIONS: readonly ToolbarAction[] = [
  {kind: 'icon', id: 'outdent', actionId: 'edit.cm.outdent_block', label: 'Outdent', icon: IndentDecrease},
  {kind: 'icon', id: 'indent', actionId: 'edit.cm.indent_block', label: 'Indent', icon: IndentIncrease},
  {kind: 'text', id: 'page-ref', actionId: INSERT_PAGE_REF_TRIGGER_ACTION_ID, label: 'Page reference', text: '[['},
  {kind: 'text', id: 'block-ref', actionId: INSERT_BLOCK_REF_TRIGGER_ACTION_ID, label: 'Block reference', text: '(('},
  {kind: 'icon', id: 'move-up', actionId: 'move_block_up_cm', label: 'Move up', icon: ArrowUp},
  {kind: 'icon', id: 'move-down', actionId: 'move_block_down_cm', label: 'Move down', icon: ArrowDown},
  {kind: 'icon', id: 'undo', actionId: 'undo', label: 'Undo', icon: Undo2},
  {kind: 'icon', id: 'redo', actionId: 'redo', label: 'Redo', icon: Redo2},
  {kind: 'icon', id: 'done', actionId: EXIT_EDIT_ACTION_ID, label: 'Done', icon: KeyboardOff},
]

const ToolbarButtonContent = ({action}: {action: ToolbarAction}) => {
  if (action.kind === 'text') {
    return <span className="font-mono text-base font-semibold leading-none">{action.text}</span>
  }

  const Icon = action.icon
  return <Icon className="h-5 w-5"/>
}

/** Computes the on-screen keyboard's CSS-px inset for the toolbar.
 *
 *  Three browser shapes have to be handled and earlier attempts each
 *  broke at least one:
 *  - Chrome on Android (resizes-content default): both layout and
 *    visual viewports shrink with the IME. `bottom: 0` already lands
 *    above the keyboard; we just want inset = 0.
 *  - iOS Safari: visual viewport shrinks, layout stays full, but
 *    position:fixed is *pinned to the visual viewport*. `bottom: 0`
 *    again lands above the keyboard; inset must be 0 or we open a gap.
 *  - Edge / Samsung Internet on Android: visual viewport shrinks,
 *    layout stays full, AND position:fixed is anchored to the layout
 *    viewport. `bottom: 0` lands under the keyboard; inset must be the
 *    keyboard height — and *just* the keyboard height, not the URL
 *    bar (which is what the naive `innerHeight - vv.height` formula
 *    accidentally added in earlier attempts, producing the gap the
 *    user reported).
 *
 *  The fix has two pieces:
 *  - Track a *baseline* maximum visualViewport.height across the
 *    component lifetime. The URL bar height is constant — present in
 *    both the baseline and the current measurement — so it cancels
 *    out. The keyboard height is the only delta:
 *    `keyboardHeight = baseline - current`.
 *  - Use a hidden 1×1 sentinel at `position: fixed; bottom: 0` to
 *    detect which anchoring mode the browser is using. If the
 *    sentinel's bottom (in CSS-px) sits below the visual viewport's
 *    bottom, the browser is layout-anchoring fixed elements (Edge
 *    case) and we apply the inset. Otherwise (Chrome / iOS) we keep
 *    inset = 0 because `bottom: 0` is already correct. */
const useKeyboardInset = (active: boolean): number => {
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const [inset, setInset] = useState(0)

  useLayoutEffect(() => {
    if (!active || typeof document === 'undefined') return
    const el = document.createElement('div')
    el.setAttribute('aria-hidden', 'true')
    Object.assign(el.style, {
      position: 'fixed',
      left: '0',
      bottom: '0',
      width: '1px',
      height: '1px',
      pointerEvents: 'none',
      visibility: 'hidden',
    } as Partial<CSSStyleDeclaration>)
    document.body.appendChild(el)
    sentinelRef.current = el
    return () => {
      document.body.removeChild(el)
      sentinelRef.current = null
    }
  }, [active])

  useEffect(() => {
    if (!active || typeof window === 'undefined') return
    const vv = window.visualViewport

    // Seed the baseline with the larger of innerHeight and the current
    // visualViewport height. If the toolbar mounts AFTER the keyboard
    // is already up (vv.height already shrunk), innerHeight still
    // reflects the no-keyboard layout viewport on layout-anchored
    // browsers, so it's the right ceiling. On `resizes-content`
    // browsers innerHeight has shrunk too, but the sentinel-based
    // anchoring check below gates inset to 0 in that case anyway.
    let maxVvHeight = Math.max(vv?.height ?? 0, window.innerHeight)

    const update = () => {
      const sentinel = sentinelRef.current
      if (!sentinel) return
      const sentinelBottom = sentinel.getBoundingClientRect().bottom
      const vvHeight = vv?.height ?? window.innerHeight

      if (vvHeight > maxVvHeight) maxVvHeight = vvHeight

      // Anchoring detection: when position:fixed is pinned to the
      // visual viewport, the sentinel sits flush with vv.bottom and
      // sentinelBottom == vvHeight. When it's anchored to the layout
      // viewport, the sentinel sits past the visual viewport bottom
      // and sentinelBottom > vvHeight. The 1px tolerance absorbs
      // sub-pixel rounding from getBoundingClientRect().
      const isLayoutAnchored = sentinelBottom > vvHeight + 1
      const keyboardHeight = Math.max(0, maxVvHeight - vvHeight)
      const next = isLayoutAnchored ? Math.round(keyboardHeight) : 0

      setInset(prev => (prev === next ? prev : next))
    }

    update()
    if (vv) {
      vv.addEventListener('resize', update)
      vv.addEventListener('scroll', update)
    }
    window.addEventListener('resize', update)
    return () => {
      if (vv) {
        vv.removeEventListener('resize', update)
        vv.removeEventListener('scroll', update)
      }
      window.removeEventListener('resize', update)
    }
  }, [active])

  return inset
}

/** Mobile-only toolbar that sits above the on-screen keyboard while a
 *  block is being edited, exposing tap targets for the workflowy/roam-
 *  style block commands (indent / outdent / reorder / undo / done).
 *  Each button dispatches the same action id that the keyboard binding
 *  invokes, so behavior stays in lockstep with the desktop shortcuts. */
export function MobileKeyboardToolbar() {
  const isMobile = useIsMobile()
  // Editing state is per-panel (`isEditingProp` is set on the panel's
  // UI-state block), so the app-shell `useIsEditing()` hook — which
  // resolves to the user-root UI-state block when no panel context is
  // present — never sees `true`. The active-contexts map is the
  // panel-agnostic source of truth: a CodeMirror editor in edit mode
  // activates EDIT_MODE_CM regardless of which panel hosts it.
  const activeContexts = useActiveContextsState()
  const isEditing = activeContexts.has(ActionContextTypes.EDIT_MODE_CM)
  const runAction = useRunAction()
  // Hooks above the early-return must run on every render. Pass the
  // activation flag in so the sentinel only mounts/listens while the
  // toolbar is on screen.
  const keyboardInset = useKeyboardInset(isMobile && isEditing)

  if (!isMobile || !isEditing) return null

  // Prevent the editor from blurring when a button is pressed — losing
  // focus would dismiss the on-screen keyboard mid-tap and tear down
  // the EDIT_MODE_CM context the action depends on. `mousedown` is
  // dispatched by both mouse pointers and (via compat events) touch,
  // and preventDefault on it is the established cross-browser way to
  // keep the active element anchored through a tap on a different DOM
  // node — same pattern used by the autocomplete popovers in this app.
  const handleMouseDown = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
  }

  const getActiveEditorView = () => {
    const editDeps = activeContexts.get(ActionContextTypes.EDIT_MODE_CM) as
      | CodeMirrorEditModeDependencies
      | undefined
    return editDeps?.editorView
  }

  const handleClick = (actionId: string) => async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()

    // Snapshot the editor view from the EDIT_MODE_CM dependencies
    // BEFORE the action runs, so a structural action that swaps panels
    // mid-flight can't trick us into focusing the wrong editor.
    const editorView = getActiveEditorView()

    // Action handlers expect ActionTrigger = KeyboardEvent | CustomEvent.
    // None of the actions wired to this toolbar consult the trigger,
    // but typing demands one — synthesize a CustomEvent so we don't
    // misrepresent a click as a keyboard event.
    const trigger = new CustomEvent('mobile-toolbar-action', {detail: {actionId}})

    // Some actions reorder the focused block's DOM node, and the
    // reparenting drops native focus from the contenteditable. The
    // editor's onBlur then schedules a raf that exits edit mode
    // because document.activeElement is no longer inside any
    // .cm-editor. The blur fires whenever React eventually commits
    // the post-mutation render — that's *after* this handler returns,
    // and the timing is variable (PowerSync subscription → React
    // batched render → DOM diff/commit → blur). Stacked requestAnimation
    // Frames aren't enough; the blur regularly lands several frames
    // later still. Acquire a hold for a window that covers the worst-
    // case render delay (~150ms in playwright) plus headroom; the
    // BlockEditor's onBlur honors the hold by re-focusing instead of
    // dropping out of edit mode. The Done button is the *one* path
    // that genuinely wants edit mode off — leave its blur alone.
    const releaseHold = actionId === EXIT_EDIT_ACTION_ID
      ? null
      : acquireBlurExitSuppression()
    try {
      await runAction(actionId, trigger)
    } catch (error) {
      console.error(`[MobileKeyboardToolbar] Failed to run ${actionId}`, error)
    }
    if (releaseHold) {
      scheduleBlurExitSuppressionRelease(releaseHold)
      // Snap focus back immediately for the common case where the editor
      // is already remounted under the new DOM position. If it isn't yet,
      // the suppressed blur won't tear us out of edit mode and the next
      // edit-driven focus effect catches up.
      requestAnimationFrame(() => editorView?.focus())
    }
  }

  return (
    <div
      // `keyboardInset` is 0 on browsers where bottom:0 already lands
      // above the keyboard (Chrome on Android, iOS Safari) and equals
      // the keyboard's CSS-px height on browsers that anchor
      // position:fixed to a full-height layout viewport (Edge,
      // Samsung Internet) — see useKeyboardInset.
      className="mobile-keyboard-toolbar fixed left-0 right-0 z-50 flex items-center justify-around gap-1 border-t border-border bg-background/95 px-1 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      style={{bottom: keyboardInset}}
      data-block-interaction="ignore"
    >
      {TOOLBAR_ACTIONS.map(action => (
        <button
          key={action.id}
          type="button"
          aria-label={action.label}
          title={action.label}
          onMouseDown={handleMouseDown}
          onClick={handleClick(action.actionId)}
          className="flex h-10 min-w-0 flex-1 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-accent active:text-accent-foreground"
        >
          <ToolbarButtonContent action={action}/>
        </button>
      ))}
    </div>
  )
}
