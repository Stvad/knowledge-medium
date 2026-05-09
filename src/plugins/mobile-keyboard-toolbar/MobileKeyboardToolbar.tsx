import { type MouseEvent } from 'react'
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
      // bottom: 0 is enough — modern Chrome on Android shrinks both
      // viewports when the IME shows, and modern iOS Safari pins
      // position:fixed elements to the visual viewport, so a fixed
      // bottom-0 element is already flush above the keyboard. Adding
      // a manual visualViewport-derived inset on top of that double-
      // counts and leaves a gap.
      className="mobile-keyboard-toolbar fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around gap-1 border-t border-border bg-background/95 px-1 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/80"
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
