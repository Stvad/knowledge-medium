import type { TouchEvent } from 'react'
import {
  isInteractiveContentEvent,
  type BlockContentSurfaceContribution,
} from '@/extensions/blockInteraction.js'
import {
  claimBlockGesture,
  releaseBlockGesture,
} from '@/extensions/blockGestureConflicts.js'
import { isEditingProp, isFocusedBlock } from '@/data/properties.js'
import type { Block } from '@/data/block'
import {
  dispatchSwipeQuickActionMenuEvent,
  dispatchSwipeQuickActionProgressEvent,
  dispatchSwipeQuickActionRunEvent,
  SWIPE_QUICK_ACTION_CLOSE_EVENT,
  SWIPE_QUICK_ACTION_OPEN_EVENT,
} from './events.ts'
import { SWIPE_RIGHT_BLOCK_ACTION_ID } from './actions.ts'

/** Identifier for the block-gesture-conflicts facet contribution. The
 *  facet uses this to route eviction `onCancel` calls when another
 *  gesture claims a block this gesture currently holds. */
export const SWIPE_QUICK_ACTIONS_GESTURE_ID = 'swipe-quick-actions'

interface TouchStart {
  x: number
  y: number
  time: number
  /** The Touch.identifier of the finger that started the gesture. Used
   *  to pick the same finger out of `touches` / `changedTouches` on
   *  subsequent events — without this, a second finger landing or
   *  lifting on the same block during the gesture could swap which
   *  entry sits at index 0 and produce a bogus dx that spuriously
   *  opens or closes the menu. */
  identifier: number
  /** Once a horizontal-swipe intent is locked in, we set this so further
   *  movement doesn't keep re-evaluating direction. */
  decided: 'horizontal' | 'vertical' | null
  /** True once we've emitted at least one 'active' progress event for
   *  this gesture. We owe the menu a matching 'cancel' on any exit
   *  path that doesn't commit to opening — including the case where
   *  the finger crossed zero on the way out and the final `dx` is no
   *  longer negative. Re-deriving from the final dx would miss those
   *  reversed gestures and leave the toolbar stuck partially revealed. */
  previewed: boolean
}

const touchStartByBlockId = new Map<string, TouchStart>()

/** Drop the swipe candidate for `blockId`. Registered as this gesture's
 *  `onCancel` on the block-gesture-conflicts facet, so another gesture
 *  taking the slot (e.g. date-scrub crossing its activation threshold)
 *  fires this and prevents the eventual touchend from opening the
 *  swipe menu on top of the new gesture. Also exported for callers
 *  that need to clear local state directly. Returns true if a
 *  candidate was actually cleared. */
export const cancelSwipeCandidate = (blockId: string): boolean =>
  touchStartByBlockId.delete(blockId)

/** Find the Touch in a TouchList whose identifier matches the gesture's
 *  starting finger. Returns null if the gesture's finger isn't in the
 *  list (e.g. a different finger fired this event), in which case the
 *  caller should leave the gesture state alone. */
const findTrackedTouch = (
  list: { length: number; [index: number]: { identifier: number } } | undefined | null,
  identifier: number,
): { clientX: number; clientY: number } | null => {
  if (!list) return null
  for (let i = 0; i < list.length; i++) {
    const entry = list[i] as unknown as { identifier: number; clientX: number; clientY: number }
    if (entry.identifier === identifier) return entry
  }
  return null
}

/** Min horizontal travel before we commit to "this is a swipe" and reveal
 *  the menu. Below this we leave the gesture alone so vertical scrolls and
 *  taps behave normally. */
export const SWIPE_TRIGGER_PX = 50

/** Once dx exceeds this small threshold AND |dx| > |dy|, lock direction
 *  to horizontal. Picked low enough to feel responsive; the trigger
 *  threshold above is what actually opens the menu. */
const DIRECTION_LOCK_PX = 8

/** The menu is mobile-only — `SwipeActionMenu` early-returns when
 *  `useIsMobile()` is false. The gesture handler must apply the same
 *  gate, otherwise touch-capable laptops/tablets >767px would still
 *  consume the swipe and render nothing, making horizontal gestures
 *  appear broken. We can't call the
 *  hook here, so we read the same media query directly at fire time. */
const MOBILE_BREAKPOINT_QUERY = '(max-width: 767px)'

const isMobileViewport = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches
}

const isBlockEditing = (blockId: string, uiStateBlock: Block, renderScopeId?: string): boolean =>
  isFocusedBlock(uiStateBlock, blockId, renderScopeId) &&
  Boolean(uiStateBlock.peekProperty(isEditingProp))

const isSwipeGestureSurfaceEvent = (event: { target: EventTarget | null }): boolean => {
  const target = event.target
  if (typeof Node === 'undefined' || !(target instanceof Node)) return false
  const element = target.nodeType === Node.ELEMENT_NODE
    ? target as Element
    : target.parentElement
  return Boolean(element?.closest('a[href],video'))
}

export const swipeQuickActionsContentSurface: BlockContentSurfaceContribution = context => {
  const {block, uiStateBlock} = context
  const renderScopeId = context.blockContext?.renderScopeId

  return {
    onTouchStart: (event: TouchEvent) => {
      // Mobile-only — see MOBILE_BREAKPOINT_QUERY note above. Skip the
      // candidate setup entirely on wider viewports so onTouchEnd has no
      // start record to act on.
      if (!isMobileViewport()) return
      // Don't intercept gestures starting on buttons, the editor,
      // or anything else that already owns its own touch behavior.
      // Links and video are the exceptions: they can occupy a large part
      // of readable content, and taps still work because only a completed
      // horizontal swipe calls preventDefault.
      if (!isSwipeGestureSurfaceEvent(event) && isInteractiveContentEvent(event)) {
        touchStartByBlockId.delete(block.id)
        releaseBlockGesture(block.id, SWIPE_QUICK_ACTIONS_GESTURE_ID)
        return
      }
      // While a block is being edited, the CodeMirror editor owns the
      // touch surface — selection drags etc. shouldn't trigger a menu.
      if (isBlockEditing(block.id, uiStateBlock, renderScopeId)) return

      // First finger down on this block wins the gesture; later fingers
      // landing on the same block while a gesture is already in flight
      // are ignored, otherwise the second finger's coords would
      // overwrite the first finger's start position. Touch.identifier
      // pairs the tracked finger across move/end events — list-index
      // pairing is unsafe when fingers come and go.
      if (touchStartByBlockId.has(block.id)) return
      const touch = event.changedTouches[0]
      if (!touch) return

      touchStartByBlockId.set(block.id, {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
        identifier: touch.identifier,
        decided: null,
        previewed: false,
      })
      // Claim the block-level gesture slot eagerly: another gesture
      // that crosses its threshold later (e.g. two-finger scrub) needs
      // to evict us so the eventual touchend doesn't open the menu on
      // top of theirs. The claim is released on every exit path below.
      claimBlockGesture(
        block.repo.facetRuntime,
        block.id,
        SWIPE_QUICK_ACTIONS_GESTURE_ID,
      )
    },

    onTouchMove: (event: TouchEvent) => {
      const start = touchStartByBlockId.get(block.id)
      if (!start) return

      const touch = findTrackedTouch(event.touches, start.identifier)
      // Some other finger moved — ignore the event so we don't update
      // direction based on a finger we're not tracking.
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
        releaseBlockGesture(block.id, SWIPE_QUICK_ACTIONS_GESTURE_ID)
        return
      }

      // Stream live progress for the toolbar reveal preview. Only the
      // leftward (opening) gesture has a preview — right-swipe on the
      // closed block surface runs a semantic action and doesn't need
      // intermediate visual feedback.
      if (start.decided === 'horizontal' && dx < 0 && !isBlockEditing(block.id, uiStateBlock, renderScopeId)) {
        start.previewed = true
        dispatchSwipeQuickActionProgressEvent(event.currentTarget, block.id, dx, 'active')
      }
    },

    onTouchEnd: (event: TouchEvent) => {
      const start = touchStartByBlockId.get(block.id)
      if (!start) return

      // Only act when the finger that started the gesture lifts. A
      // different finger lifting (multi-touch tap, casual second
      // finger) leaves the tracked finger still down, so we keep the
      // gesture state alive for the eventual matching touchend.
      const touch = findTrackedTouch(event.changedTouches, start.identifier)
      if (!touch) return

      touchStartByBlockId.delete(block.id)
      releaseBlockGesture(block.id, SWIPE_QUICK_ACTIONS_GESTURE_ID)

      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      const previewed = start.previewed
      let openCommitted = false

      // Horizontal-only — vertical scrolls and taps are someone else's job.
      // Swipe-left opens this block's menu in this panel. Swipe-right on
      // the block surface runs the semantic block action; if no mounted
      // runtime handles that action, we preserve the old fallback of
      // asking the panel menu to dismiss when anchored here. A rightward
      // swipe directly on the open menu/toolbar is handled inside
      // SwipeActionMenu itself and remains the close gesture.
      if (Math.abs(dx) > Math.abs(dy)) {
        if (dx <= -SWIPE_TRIGGER_PX && !isBlockEditing(block.id, uiStateBlock, renderScopeId)) {
          const handled = !dispatchSwipeQuickActionMenuEvent(
            event.currentTarget,
            SWIPE_QUICK_ACTION_OPEN_EVENT,
            block.id,
          )
          if (handled) {
            event.preventDefault()
            event.stopPropagation()
            openCommitted = true
          }
        } else if (dx >= SWIPE_TRIGGER_PX) {
          const actionHandled = !dispatchSwipeQuickActionRunEvent(
            event.currentTarget,
            SWIPE_RIGHT_BLOCK_ACTION_ID,
            block.id,
          )
          if (actionHandled) {
            event.preventDefault()
            event.stopPropagation()
          } else {
            const handled = !dispatchSwipeQuickActionMenuEvent(
              event.currentTarget,
              SWIPE_QUICK_ACTION_CLOSE_EVENT,
              block.id,
            )
            if (handled) {
              event.preventDefault()
              event.stopPropagation()
            }
          }
        }
      }

      // If we previewed during the drag and didn't commit to opening,
      // tell the menu to animate the toolbar back. Catches every
      // non-committing exit, including the reversed-past-zero case
      // (drag left, then back right) where final dx wouldn't tell us
      // a preview was in flight.
      if (previewed && !openCommitted) {
        dispatchSwipeQuickActionProgressEvent(event.currentTarget, block.id, dx, 'cancel')
      }
    },

    onTouchCancel: (event: TouchEvent) => {
      const start = touchStartByBlockId.get(block.id)
      if (!start) return
      // Drop the gesture only if the tracked finger is the one being
      // cancelled. A different finger getting cancelled (e.g. an
      // unrelated multi-touch interrupt) leaves our tracked finger
      // in play.
      if (findTrackedTouch(event.changedTouches, start.identifier)) {
        touchStartByBlockId.delete(block.id)
        releaseBlockGesture(block.id, SWIPE_QUICK_ACTIONS_GESTURE_ID)
        // If we had been previewing, settle back. The dx isn't
        // recoverable here so we pass 0 — the menu just needs the
        // 'cancel' signal to start its hide animation.
        if (start.previewed) {
          dispatchSwipeQuickActionProgressEvent(event.currentTarget, block.id, 0, 'cancel')
        }
      }
    },
  }
}
