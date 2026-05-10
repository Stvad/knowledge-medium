import type { TouchEvent } from 'react'
import {
  isInteractiveContentEvent,
  type BlockContentSurfaceContribution,
} from '@/extensions/blockInteraction.ts'
import { focusedBlockIdProp, isEditingProp } from '@/data/properties.ts'
import { Block } from '@/data/block'
import {
  setActiveSwipeTarget,
  clearActiveSwipeTarget,
  getActiveSwipeTarget,
} from './store.ts'

interface TouchStart {
  x: number
  y: number
  time: number
  /** Once a horizontal-swipe intent is locked in, we set this so further
   *  movement doesn't keep re-evaluating direction. */
  decided: 'horizontal' | 'vertical' | null
  /** The element bearing `data-block-id` for the swiped block instance.
   *  Captured at touchstart so the menu can later anchor to the exact
   *  row the user touched, even if the same block id is rendered in
   *  another panel. Null only if the surface isn't inside a block shell
   *  (shouldn't happen in practice, but we bail safely). */
  element: HTMLElement | null
}

const touchStartByBlockId = new Map<string, TouchStart>()

/** Min horizontal travel before we commit to "this is a swipe" and reveal
 *  the menu. Below this we leave the gesture alone so vertical scrolls and
 *  taps behave normally. */
const SWIPE_TRIGGER_PX = 50

/** Once dx exceeds this small threshold AND |dx| > |dy|, lock direction
 *  to horizontal. Picked low enough to feel responsive; the trigger
 *  threshold above is what actually opens the menu. */
const DIRECTION_LOCK_PX = 8

/** The menu is mobile-only — `SwipeActionMenu` early-returns when
 *  `useIsMobile()` is false. The gesture handler must apply the same
 *  gate, otherwise touch-capable laptops/tablets >767px would still
 *  consume the swipe (preventDefault + setActive) and render nothing,
 *  making horizontal gestures appear broken. We can't call the hook
 *  here, so we read the same media query directly at fire time. */
const MOBILE_BREAKPOINT_QUERY = '(max-width: 767px)'

const isMobileViewport = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches
}

const isBlockEditing = (blockId: string, uiStateBlock: Block): boolean =>
  uiStateBlock.peekProperty(focusedBlockIdProp) === blockId &&
  Boolean(uiStateBlock.peekProperty(isEditingProp))

/** Walk up from the touch target to the closest element with a matching
 *  `data-block-id` attribute. The content surface bears no such attribute
 *  itself; the block shell (one wrapper out) does. We require the id to
 *  match the contribution's `block.id` so a synthesized event from a
 *  child block can't accidentally anchor to its ancestor's row. */
const findBlockShell = (target: EventTarget | null, blockId: string): HTMLElement | null => {
  if (!(target instanceof Element)) return null
  const shell = target.closest<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`)
  return shell
}

export const swipeQuickActionsContentSurface: BlockContentSurfaceContribution = context => {
  const {block, uiStateBlock} = context

  return {
    onTouchStart: (event: TouchEvent) => {
      // Mobile-only — see MOBILE_BREAKPOINT_QUERY note above. Skip the
      // candidate setup entirely on wider viewports so onTouchEnd has no
      // start record to act on.
      if (!isMobileViewport()) return
      // Don't intercept gestures starting on links, buttons, the editor,
      // or anything else that already owns its own touch behavior.
      if (isInteractiveContentEvent(event)) {
        touchStartByBlockId.delete(block.id)
        return
      }
      // While a block is being edited, the CodeMirror editor owns the
      // touch surface — selection drags etc. shouldn't trigger a menu.
      if (isBlockEditing(block.id, uiStateBlock)) return

      const touch = event.touches[0]
      if (!touch) return

      touchStartByBlockId.set(block.id, {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
        decided: null,
        // Resolve the swiped block's shell once at touchstart; the bbox
        // is recomputed against this same element each render so any
        // post-swipe mutations (collapse toggle, properties show/hide)
        // still anchor to the right row.
        element: findBlockShell(event.target, block.id),
      })
    },

    onTouchMove: (event: TouchEvent) => {
      const start = touchStartByBlockId.get(block.id)
      if (!start) return

      const touch = event.touches[0]
      if (!touch) return

      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y

      if (start.decided === null) {
        if (Math.abs(dx) >= DIRECTION_LOCK_PX || Math.abs(dy) >= DIRECTION_LOCK_PX) {
          start.decided = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
        }
      }

      // Once we know it's a vertical scroll, drop the candidate so a
      // later horizontal pivot mid-scroll doesn't surprise the user.
      if (start.decided === 'vertical') {
        touchStartByBlockId.delete(block.id)
      }
    },

    onTouchEnd: (event: TouchEvent) => {
      const start = touchStartByBlockId.get(block.id)
      touchStartByBlockId.delete(block.id)
      if (!start) return

      const touch = event.changedTouches[0]
      if (!touch) return

      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y

      // Horizontal-only — vertical scrolls and taps are someone else's job.
      if (Math.abs(dx) <= Math.abs(dy)) return

      // Swipe-left opens this block's menu. Swipe-right while a menu is
      // already open dismisses it; otherwise we leave swipe-right alone
      // so back-navigation gestures etc. aren't disturbed.
      if (dx <= -SWIPE_TRIGGER_PX) {
        if (isBlockEditing(block.id, uiStateBlock)) return
        // No shell element resolved? Skip — opening with a stale or
        // missing anchor would land the menu somewhere arbitrary.
        if (!start.element) return
        event.preventDefault()
        event.stopPropagation()
        setActiveSwipeTarget({blockId: block.id, element: start.element})
      } else if (dx >= SWIPE_TRIGGER_PX) {
        const active = getActiveSwipeTarget()
        // Dismiss only when the swipe-right is on the same instance the
        // menu is anchored to — a swipe-right on a different panel's row
        // shouldn't close someone else's menu.
        if (active && active.element === start.element) {
          event.preventDefault()
          event.stopPropagation()
          clearActiveSwipeTarget()
        }
      }
    },

    onTouchCancel: () => {
      touchStartByBlockId.delete(block.id)
    },
  }
}
