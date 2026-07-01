import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { useIsMobile } from '@/utils/react.js'
import { useRunAction } from '@/shortcuts/runAction.js'
import { useActiveContextsState, editorViewFromActiveContexts } from '@/shortcuts/ActiveContexts.js'
import { useActionRefItems } from '@/shortcuts/actionRefItems.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { withEditModeKeepalive } from '@/components/editModeKeepalive.js'
import { setEditingToolbarHeight } from '@/utils/keyboardViewport.js'
import { EXIT_EDIT_ACTION_ID, mobileKeyboardToolbarItemsFacet } from './facet.ts'

/** Reserves the on-screen keyboard's intrusion as the toolbar's `bottom`, so
 *  the `position: fixed` toolbar sits just above the keyboard.
 *
 *  The toolbar's `bottom` is measured from the LAYOUT viewport's bottom. On
 *  iOS Safari the layout viewport stays full-height while the keyboard is up
 *  (the keyboard overlays it and *pans* the visual viewport), so `bottom: 0`
 *  would sit behind the keyboard. The inset lifts the toolbar by however much
 *  of the layout viewport is hidden below the visible (visual) viewport:
 *
 *    inset = documentElement.clientHeight − visualViewport.height − visualViewport.offsetTop
 *
 *  Two subtleties, both learned on-device (real iPad, Stage Manager):
 *  - Use `documentElement.clientHeight`, not `window.innerHeight`, for the
 *    layout-viewport height: innerHeight under-reports on iOS while the
 *    keyboard is up and the page is scrolled, but the fixed toolbar is
 *    positioned against the layout viewport, which clientHeight reports
 *    reliably.
 *  - Subtracting `visualViewport.offsetTop` (the pan) is the load-bearing
 *    term. iOS pans the visual viewport as you scroll with the keyboard up,
 *    shrinking the keyboard's intrusion by exactly that amount. The earlier
 *    version reserved `baseline − vv.height` and ignored the pan, so after any
 *    scroll it over-lifted the toolbar toward the top of the screen — the drift
 *    this fixes. Recomputed on visualViewport `resize` (open/close) AND
 *    `scroll` (the pan); moving a fixed toolbar doesn't itself scroll anything,
 *    so unlike re-scrolling the caret (keyboardAwareScroll) this can't loop.
 *
 *  Browser-uniform: on Chromium/Firefox `index.html`'s
 *  `interactive-widget=resizes-content` shrinks the layout viewport with the
 *  keyboard, so clientHeight and vv.height shrink together (no pan) and the
 *  inset computes to ~0 — `bottom: 0` already clears the keyboard there. Same
 *  formula, no per-browser branch, no anchoring sentinel. */
const useKeyboardInset = (active: boolean): number => {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    if (!active || typeof window === 'undefined') return
    const vv = window.visualViewport

    const update = () => {
      const layoutH = document.documentElement.clientHeight
      const vvHeight = vv?.height ?? layoutH
      const vvTop = vv?.offsetTop ?? 0
      const next = Math.max(0, Math.round(layoutH - vvHeight - vvTop))
      setInset(prev => (prev === next ? prev : next))
    }

    update()
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [active])

  return inset
}

/** Mobile-only toolbar that sits above the on-screen keyboard while a
 *  block is being edited. Its buttons are facet contributions
 *  (`mobileKeyboardToolbarItemsFacet`): the structural/reference set comes
 *  from this plugin, and other plugins add their own (the image button from
 *  attachments, the todo toggle from todo). Each button dispatches the same
 *  action id that the keyboard binding invokes, so behavior stays in lockstep
 *  with the desktop shortcuts. */
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
  // Buttons are facet contributions, ordered by contribution precedence; each
  // button's glyph + label are read from its action (icon / description), so
  // presentation lives on the action. The toolbar only shows in edit mode, so
  // unqualified items resolve against EDIT_MODE_CM.
  const resolved = useActionRefItems(mobileKeyboardToolbarItemsFacet, ActionContextTypes.EDIT_MODE_CM)
  // Hooks above the early-return must run on every render. Pass the
  // activation flag in so the sentinel only mounts/listens while the
  // toolbar is on screen.
  const keyboardInset = useKeyboardInset(isMobile && isEditing)

  // Publish the toolbar's rendered height so keyboardAwareScroll can keep
  // the caret above the toolbar, not just above the keyboard. Measured
  // (rather than hardcoded) so it tracks button/padding/safe-area changes,
  // and re-published via ResizeObserver; cleared to 0 on unmount.
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = toolbarRef.current
    if (!el) {
      setEditingToolbarHeight(0)
      return
    }
    const measure = () => setEditingToolbarHeight(el.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      observer.disconnect()
      setEditingToolbarHeight(0)
    }
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
    const editorView = editorViewFromActiveContexts(activeContexts)

    // Action handlers expect ActionTrigger = KeyboardEvent | CustomEvent.
    // None of the actions wired to this toolbar consult the trigger,
    // but typing demands one — synthesize a CustomEvent so we don't
    // misrepresent a click as a keyboard event.
    const trigger = new CustomEvent('mobile-toolbar-action', {detail: {actionId}})

    const run = async () => {
      try {
        await runAction(actionId, trigger)
      } catch (error) {
        console.error(`[MobileKeyboardToolbar] Failed to run ${actionId}`, error)
      }
    }

    // The Done button is the *one* path that genuinely wants edit mode off —
    // run it with no keepalive so its blur tears edit mode down.
    if (actionId === EXIT_EDIT_ACTION_ID) {
      await run()
      return
    }

    // Some actions reorder the focused block's DOM node, and the reparenting
    // drops native focus from the contenteditable. The editor's onBlur then
    // schedules a raf that exits edit mode because document.activeElement is no
    // longer inside any .cm-editor — and that blur lands AFTER this handler
    // returns, several frames late and variably (PowerSync → React render → DOM
    // commit → blur). Hold a 'refocus' keepalive across the action and past its
    // resolution (withEditModeKeepalive owns the timed release) so the late blur
    // re-focuses instead of dropping out of edit mode.
    await withEditModeKeepalive('refocus', run)
    // Snap focus back immediately for the common case where the editor is
    // already remounted under the new DOM position. If it isn't yet, the
    // suppressed blur won't tear us out of edit mode and the next edit-driven
    // focus effect catches up.
    requestAnimationFrame(() => editorView?.focus())
  }

  return (
    <div
      ref={toolbarRef}
      // `keyboardInset` lifts the fixed toolbar above the on-screen
      // keyboard by the keyboard's intrusion into the layout viewport:
      // nonzero on iOS Safari (layout viewport stays full-height while the
      // keyboard overlays + pans it), ~0 on Chromium/Firefox (where
      // interactive-widget=resizes-content shrinks the layout viewport, so
      // bottom:0 already clears the keyboard). See useKeyboardInset.
      className="mobile-keyboard-toolbar fixed left-0 right-0 z-50 flex items-center justify-around gap-1 border-t border-border bg-background/95 px-1 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      style={{bottom: keyboardInset}}
      data-block-interaction="ignore"
    >
      {resolved.map(({item, action}) => {
        // A button with no resolved icon is skipped (its plugin may be disabled,
        // or the action lacks an icon) — same contract as the bottom nav.
        if (!action?.icon) return null
        const Icon = action.icon
        return (
          <button
            key={item.id}
            type="button"
            aria-label={action.description}
            title={action.description}
            onMouseDown={handleMouseDown}
            onClick={handleClick(item.actionId)}
            className="flex h-10 min-w-0 flex-1 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-accent active:text-accent-foreground"
          >
            <Icon className="h-5 w-5"/>
          </button>
        )
      })}
    </div>
  )
}
