import type { TouchEvent } from 'react'
import {
  isInteractiveContentEvent,
  type BlockContentSurfaceContribution,
} from '@/extensions/blockInteraction.ts'
import { focusedBlockIdProp, isEditingProp } from '@/data/properties.ts'
import { Block } from '@/data/block'
import { swipeActiveBlockIdProp } from './property.ts'

interface TouchStart {
  x: number
  y: number
  time: number
  /** Once a horizontal-swipe intent is locked in, we set this so further
   *  movement doesn't keep re-evaluating direction. */
  decided: 'horizontal' | 'vertical' | null
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
 *  consume the swipe (preventDefault + property write) and render
 *  nothing, making horizontal gestures appear broken. We can't call the
 *  hook here, so we read the same media query directly at fire time. */
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

      // Swipe-left opens this block's menu in this panel. Swipe-right
      // dismisses only when this panel's menu is currently anchored to
      // this block — same-block-different-panel and other-block cases
      // are left alone so we don't disturb unrelated state.
      if (dx <= -SWIPE_TRIGGER_PX) {
        if (isBlockEditing(block.id, uiStateBlock)) return
        event.preventDefault()
        event.stopPropagation()
        void uiStateBlock.set(swipeActiveBlockIdProp, block.id)
      } else if (dx >= SWIPE_TRIGGER_PX) {
        if (uiStateBlock.peekProperty(swipeActiveBlockIdProp) === block.id) {
          event.preventDefault()
          event.stopPropagation()
          void uiStateBlock.set(swipeActiveBlockIdProp, undefined)
        }
      }
    },

    onTouchCancel: () => {
      touchStartByBlockId.delete(block.id)
    },
  }
}
