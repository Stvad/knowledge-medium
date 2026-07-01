import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { useIsMobile } from '@/utils/react.js'
import { useRunAction } from '@/shortcuts/runAction.js'
import { useActiveContextsState, editorViewFromActiveContexts } from '@/shortcuts/ActiveContexts.js'
import { useActionRefItems } from '@/shortcuts/actionRefItems.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { withEditModeKeepalive } from '@/components/editModeKeepalive.js'
import {
  getLayoutViewportKeyboardOverlap,
  getSoftKeyboardPresent,
  setEditingToolbarHeight,
  subscribeKeyboardViewport,
} from '@/utils/keyboardViewport.js'
import { EXIT_EDIT_ACTION_ID, mobileKeyboardToolbarItemsFacet } from './facet.ts'

/** Track a value derived from viewport geometry, recomputed on every relevant
 *  change via the shared keyboard-viewport subscription (the same listener set
 *  keyboardAwareScroll uses), and re-rendering only when the mapped value
 *  changes. `read` must be a stable module-level reader. Only subscribes while
 *  `active`, so an app with no active editor carries no listeners.
 *
 *  Accepted transient: during a rapid keyboard open/close iOS emits a burst of
 *  events while clientHeight / vv.height / offsetTop settle independently, so a
 *  derived value can be briefly off for a frame; the next event recomputes it.
 *  Not rAF-coalesced — that would add a frame of latency to the common
 *  smooth-scroll case for a rare, self-correcting blip. */
const useKeyboardViewportValue = <T,>(active: boolean, read: () => T, initial: T): T => {
  const [value, setValue] = useState(initial)

  useEffect(() => {
    if (!active || typeof window === 'undefined') return
    const update = () =>
      setValue(prev => {
        const next = read()
        return prev === next ? prev : next
      })
    update()
    return subscribeKeyboardViewport(update)
  }, [active, read])

  return value
}

/** The toolbar's `bottom` inset — the live layout-viewport keyboard overlap
 *  that lifts the `position: fixed` toolbar just above the on-screen keyboard
 *  (see `getLayoutViewportKeyboardOverlap` for the iOS clientHeight/pan
 *  rationale). ~0 on Chromium/Firefox, nonzero on iOS Safari. */
const useKeyboardInset = (active: boolean): number =>
  useKeyboardViewportValue(active, getLayoutViewportKeyboardOverlap, 0)

/** Whether a soft keyboard is currently up (pan-invariant — see
 *  `getSoftKeyboardPresent`). Lets the toolbar show on a wide iPad with no
 *  hardware keyboard, where the `useIsMobile` width gate is off. */
const useSoftKeyboardPresent = (active: boolean): boolean =>
  useKeyboardViewportValue(active, getSoftKeyboardPresent, false)

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
  // Show while editing on a narrow (phone) viewport, OR — regardless of width —
  // whenever a soft keyboard is up. The soft-keyboard arm covers a wide iPad
  // with no hardware keyboard: the keyboard appears, so the toolbar should too;
  // with a hardware keyboard connected no soft keyboard shows and the toolbar
  // stays hidden. Only detect the keyboard when the width gate wouldn't already
  // show the bar (`!isMobile`), so phones don't pay for the extra subscription.
  const softKeyboardPresent = useSoftKeyboardPresent(isEditing && !isMobile)
  const showToolbar = isEditing && (isMobile || softKeyboardPresent)
  // Hooks above the early-return must run on every render. Pass the
  // activation flag in so the sentinel only mounts/listens while the
  // toolbar is on screen.
  const keyboardInset = useKeyboardInset(showToolbar)

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
  }, [showToolbar])

  if (!showToolbar) return null

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
