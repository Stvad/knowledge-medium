import { useEffect, type MouseEvent } from 'react'
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
import { acquireBlurExitSuppression } from '@/components/BlockEditor.tsx'

interface ToolbarAction {
  id: string
  actionId: string
  label: string
  icon: typeof IndentDecrease
}

const EXIT_EDIT_ACTION_ID = 'exit_edit_mode_cm'

const TOOLBAR_ACTIONS: readonly ToolbarAction[] = [
  {id: 'outdent', actionId: 'edit.cm.outdent_block', label: 'Outdent', icon: IndentDecrease},
  {id: 'indent', actionId: 'edit.cm.indent_block', label: 'Indent', icon: IndentIncrease},
  {id: 'move-up', actionId: 'move_block_up_cm', label: 'Move up', icon: ArrowUp},
  {id: 'move-down', actionId: 'move_block_down_cm', label: 'Move down', icon: ArrowDown},
  {id: 'undo', actionId: 'undo', label: 'Undo', icon: Undo2},
  {id: 'redo', actionId: 'redo', label: 'Redo', icon: Redo2},
  {id: 'done', actionId: EXIT_EDIT_ACTION_ID, label: 'Done', icon: KeyboardOff},
]

/** Opt the page into the VirtualKeyboard API on browsers that support
 *  it (Chrome / Edge / Samsung Internet on Android, version-gated).
 *  With `overlaysContent = true`:
 *  - The browser stops shrinking visualViewport when the IME shows.
 *  - It exposes `env(keyboard-inset-height)` (and friends) so CSS can
 *    react to the IME without our JS having to guess where the
 *    keyboard ends.
 *
 *  This is the cleanest solution for the toolbar's positioning problem
 *  on Android (Edge / Samsung). Without this opt-in, Edge leaves the
 *  layout viewport at full height *and* anchors position:fixed to it,
 *  so `bottom:0` lands under the keyboard; computing an inset from
 *  visualViewport would in turn overshoot by the URL-bar height
 *  (innerHeight includes browser chrome that vv.height excludes).
 *  iOS Safari doesn't support the API but pins position:fixed to the
 *  visual viewport itself, so `env(keyboard-inset-height, 0px)`
 *  resolving to 0 — combined with `bottom: env(...)` — already lands
 *  the toolbar above the keyboard.
 *
 *  Idempotent and only takes effect when the API exists. */
const enableVirtualKeyboardOverlay = (): void => {
  if (typeof navigator === 'undefined') return
  const vk = (navigator as Navigator & {
    virtualKeyboard?: { overlaysContent: boolean }
  }).virtualKeyboard
  if (!vk) return
  if (!vk.overlaysContent) vk.overlaysContent = true
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

  // Opt into the VirtualKeyboard API once the toolbar would actually
  // appear — pulling this up to mount-time would penalize sessions
  // that never edit on mobile by changing the layout-viewport
  // semantics for nothing. Idempotent on subsequent calls.
  useEffect(() => {
    if (isMobile && isEditing) enableVirtualKeyboardOverlay()
  }, [isMobile, isEditing])

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

  const handleClick = (actionId: string) => async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()

    // Snapshot the editor view from the EDIT_MODE_CM dependencies
    // BEFORE the action runs, so a structural action that swaps panels
    // mid-flight can't trick us into focusing the wrong editor.
    const editDeps = activeContexts.get(ActionContextTypes.EDIT_MODE_CM) as
      | CodeMirrorEditModeDependencies
      | undefined
    const editorView = editDeps?.editorView

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
      window.setTimeout(releaseHold, 400)
      // Snap focus back immediately for the common case where the editor
      // is already remounted under the new DOM position. If it isn't yet,
      // the suppressed blur won't tear us out of edit mode and the next
      // edit-driven focus effect catches up.
      requestAnimationFrame(() => editorView?.focus())
    }
  }

  return (
    <div
      // `env(keyboard-inset-height)` resolves to the IME's height in CSS
      // px on browsers with the VirtualKeyboard API enabled (we opt in
      // above). Falls back to 0 on browsers that don't expose it (notably
      // iOS Safari) — but iOS Safari pins position:fixed to the visual
      // viewport itself, so `bottom:0` is already flush above the
      // keyboard there. The fallback covers older Chromiums equivalently
      // for the no-keyboard case.
      className="mobile-keyboard-toolbar fixed left-0 right-0 z-50 flex items-center justify-around gap-1 border-t border-border bg-background/95 px-1 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      style={{bottom: 'env(keyboard-inset-height, 0px)'}}
      data-block-interaction="ignore"
    >
      {TOOLBAR_ACTIONS.map(({id, actionId, label, icon: Icon}) => (
        <button
          key={id}
          type="button"
          aria-label={label}
          title={label}
          onMouseDown={handleMouseDown}
          onClick={handleClick(actionId)}
          className="flex h-10 flex-1 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-accent active:text-accent-foreground"
        >
          <Icon className="h-5 w-5"/>
        </button>
      ))}
    </div>
  )
}
