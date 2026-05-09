import { useEffect, useState, type MouseEvent } from 'react'
import {
  IndentDecrease,
  IndentIncrease,
  ArrowUp,
  ArrowDown,
  Undo2,
  Redo2,
  KeyboardOff,
} from 'lucide-react'
import { useIsEditing } from '@/data/globalState.ts'
import { useIsMobile } from '@/utils/react.tsx'
import { useRunAction } from '@/shortcuts/runAction.ts'

interface ToolbarAction {
  id: string
  actionId: string
  label: string
  icon: typeof IndentDecrease
}

const TOOLBAR_ACTIONS: readonly ToolbarAction[] = [
  {id: 'outdent', actionId: 'edit.cm.outdent_block', label: 'Outdent', icon: IndentDecrease},
  {id: 'indent', actionId: 'edit.cm.indent_block', label: 'Indent', icon: IndentIncrease},
  {id: 'move-up', actionId: 'move_block_up_cm', label: 'Move up', icon: ArrowUp},
  {id: 'move-down', actionId: 'move_block_down_cm', label: 'Move down', icon: ArrowDown},
  {id: 'undo', actionId: 'undo', label: 'Undo', icon: Undo2},
  {id: 'redo', actionId: 'redo', label: 'Redo', icon: Redo2},
  {id: 'done', actionId: 'exit_edit_mode_cm', label: 'Done', icon: KeyboardOff},
]

/** Tracks the visualViewport's keyboard inset so the toolbar can sit
 *  flush against the top of the on-screen keyboard. iOS pins the
 *  visualViewport above the keyboard while leaving the layout viewport
 *  at the full window height; without compensating, a `bottom: 0`
 *  fixed element would render under the keyboard. Browsers without
 *  visualViewport (or where the keyboard already shrinks the layout
 *  viewport — most Android cases) read offset 0 and just pin to the
 *  bottom edge. */
const useKeyboardOffset = (): number => {
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const vv = window.visualViewport
    if (!vv) return

    const update = () => {
      const inset = window.innerHeight - vv.height - vv.offsetTop
      setOffset(Math.max(0, inset))
    }

    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  return offset
}

/** Mobile-only toolbar that sits above the on-screen keyboard while a
 *  block is being edited, exposing tap targets for the workflowy/roam-
 *  style block commands (indent / outdent / reorder / undo / done).
 *  Each button dispatches the same action id that the keyboard binding
 *  invokes, so behavior stays in lockstep with the desktop shortcuts. */
export function MobileKeyboardToolbar() {
  const isMobile = useIsMobile()
  const [isEditing] = useIsEditing()
  const runAction = useRunAction()
  const keyboardOffset = useKeyboardOffset()

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
    // Action handlers expect ActionTrigger = KeyboardEvent | CustomEvent.
    // None of the actions wired to this toolbar consult the trigger,
    // but typing demands one — synthesize a CustomEvent so we don't
    // misrepresent a click as a keyboard event.
    const trigger = new CustomEvent('mobile-toolbar-action', {detail: {actionId}})
    try {
      await runAction(actionId, trigger)
    } catch (error) {
      console.error(`[MobileKeyboardToolbar] Failed to run ${actionId}`, error)
    }
  }

  return (
    <div
      className="mobile-keyboard-toolbar fixed left-0 right-0 z-50 flex items-center justify-around gap-1 border-t border-border bg-background/95 px-1 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      style={{bottom: keyboardOffset}}
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
