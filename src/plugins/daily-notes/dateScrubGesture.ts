/**
 * Long-press → drag-to-scrub gesture (option-2 prototype). The user
 * presses-and-holds on a block whose date can be shifted; after a short
 * threshold a floating preview tooltip appears, and horizontal drag
 * adjusts the date day-by-day. Release commits, vertical drag cancels.
 *
 * Coordination contract:
 *   - The React overlay (`DateScrubOverlay`) registers itself as the
 *     `ScrubHandler` on mount and unregisters on unmount. The overlay
 *     owns the runtime + adapter resolution + tooltip rendering.
 *   - This module owns the touch tracking: long-press timer, movement
 *     thresholds, sign of horizontal travel, scrub-active flag.
 *   - When the long-press fires, we ask the handler to start. If it
 *     accepts, we cancel the swipe-quick-actions candidate so the same
 *     touchend doesn't open the swipe menu.
 */
import type { TouchEvent } from 'react'
import {
  isInteractiveContentEvent,
  type BlockContentSurfaceContribution,
} from '@/extensions/blockInteraction.ts'
import {
  focusedBlockIdProp,
  isEditingProp,
} from '@/data/properties.ts'
import type { Block } from '@/data/block'
import { cancelSwipeCandidate } from '@/plugins/swipe-quick-actions'

const MOBILE_BREAKPOINT_QUERY = '(max-width: 767px)'
const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches

const LONG_PRESS_MS = 350
/** During the long-press wait, this much travel cancels the candidate
 *  and lets the swipe / scroll gesture take over. Higher than the
 *  swipe direction-lock so a tap that twitches a few pixels still
 *  enters scrub mode. */
const LONG_PRESS_TOLERANCE_PX = 10
/** Pixels of horizontal drag per ISO day. Picked so that ±2 weeks fits
 *  inside half a thumb-arc on a phone (~200px = 14 days). */
const PIXELS_PER_DAY = 14
/** Vertical travel above this — once scrub is active — snaps the
 *  gesture into "cancel" intent. Released past this point reverts. */
const VERTICAL_CANCEL_PX = 60
/** Caps so a wild horizontal swing across the screen doesn't put the
 *  date a year out by accident. The user can still tap calendar
 *  chips for big jumps. */
const MAX_OFFSET_DAYS = 90
const MIN_OFFSET_DAYS = -90

export interface ScrubStartArgs {
  block: Block
  blockId: string
  startX: number
  startY: number
}

export interface ScrubHandler {
  /** Returns true if the overlay accepted the scrub (block is
   *  date-shiftable). Returning false makes the gesture revert as if
   *  the long-press never fired. */
  start: (args: ScrubStartArgs) => boolean
  update: (deltaDays: number, intentCancel: boolean) => void
  end: (commit: boolean) => void
}

let activeHandler: ScrubHandler | null = null

export const registerScrubHandler = (handler: ScrubHandler): (() => void) => {
  activeHandler = handler
  return () => {
    if (activeHandler === handler) activeHandler = null
  }
}

interface PressTracker {
  blockId: string
  identifier: number
  startX: number
  startY: number
  /** Long-press timer id, or 0 once the timer has fired (or been
   *  cancelled). */
  timerId: number
  /** True once `start` returned true and we're consuming touchmove for
   *  date-scrubbing. */
  scrubbing: boolean
}

const pressByBlockId = new Map<string, PressTracker>()

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

const isBlockEditing = (blockId: string, uiStateBlock: Block): boolean =>
  uiStateBlock.peekProperty(focusedBlockIdProp) === blockId &&
  Boolean(uiStateBlock.peekProperty(isEditingProp))

const isOnInteractiveSurface = (event: { target: EventTarget | null }): boolean => {
  const target = event.target
  if (typeof Node === 'undefined' || !(target instanceof Node)) return false
  const element = target.nodeType === Node.ELEMENT_NODE
    ? target as Element
    : target.parentElement
  return Boolean(element?.closest('a[href],video'))
}

const clearTimer = (tracker: PressTracker): void => {
  if (tracker.timerId !== 0) {
    window.clearTimeout(tracker.timerId)
    tracker.timerId = 0
  }
}

const fireLongPress = (
  tracker: PressTracker,
  block: Block,
): void => {
  tracker.timerId = 0
  if (!activeHandler) return
  const accepted = activeHandler.start({
    block,
    blockId: tracker.blockId,
    startX: tracker.startX,
    startY: tracker.startY,
  })
  if (!accepted) return
  tracker.scrubbing = true
  cancelSwipeCandidate(tracker.blockId)
}

const computeDeltaDays = (dx: number): number => {
  const raw = Math.round(dx / PIXELS_PER_DAY)
  if (raw > MAX_OFFSET_DAYS) return MAX_OFFSET_DAYS
  if (raw < MIN_OFFSET_DAYS) return MIN_OFFSET_DAYS
  return raw
}

export const dateScrubContentSurface: BlockContentSurfaceContribution = context => {
  const {block, uiStateBlock} = context

  return {
    onTouchStart: (event: TouchEvent) => {
      if (!isMobileViewport()) return
      // Same exemption set as the swipe gesture — buttons / editor /
      // links / video shouldn't co-opt their own touch handling.
      if (!isOnInteractiveSurface(event) && isInteractiveContentEvent(event)) {
        const stale = pressByBlockId.get(block.id)
        if (stale) clearTimer(stale)
        pressByBlockId.delete(block.id)
        return
      }
      if (isBlockEditing(block.id, uiStateBlock)) return
      if (pressByBlockId.has(block.id)) return

      const touch = event.changedTouches[0]
      if (!touch) return

      const tracker: PressTracker = {
        blockId: block.id,
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        timerId: 0,
        scrubbing: false,
      }
      tracker.timerId = window.setTimeout(() => fireLongPress(tracker, block), LONG_PRESS_MS)
      pressByBlockId.set(block.id, tracker)
    },

    onTouchMove: (event: TouchEvent) => {
      const tracker = pressByBlockId.get(block.id)
      if (!tracker) return

      const touch = findTrackedTouch(event.touches, tracker.identifier)
      if (!touch) return

      const dx = touch.clientX - tracker.startX
      const dy = touch.clientY - tracker.startY

      // Pre-activation: too much movement → it's a swipe/scroll, not
      // a press-and-hold. Drop the candidate so the long-press timer
      // doesn't fire mid-gesture.
      if (!tracker.scrubbing) {
        if (Math.abs(dx) > LONG_PRESS_TOLERANCE_PX || Math.abs(dy) > LONG_PRESS_TOLERANCE_PX) {
          clearTimer(tracker)
          pressByBlockId.delete(block.id)
        }
        return
      }

      // Active scrub: feed the overlay the candidate offset and the
      // cancel-intent flag. Suppress the default touch behavior so the
      // page doesn't scroll under the user's drag.
      event.preventDefault()
      const intentCancel = Math.abs(dy) > VERTICAL_CANCEL_PX
      activeHandler?.update(computeDeltaDays(dx), intentCancel)
    },

    onTouchEnd: (event: TouchEvent) => {
      const tracker = pressByBlockId.get(block.id)
      if (!tracker) return

      const touch = findTrackedTouch(event.changedTouches, tracker.identifier)
      // Different finger lifted while ours is still down — wait for
      // ours.
      if (!touch) return

      const wasScrubbing = tracker.scrubbing
      clearTimer(tracker)
      pressByBlockId.delete(block.id)

      if (!wasScrubbing) return

      const dy = touch.clientY - tracker.startY
      const cancel = Math.abs(dy) > VERTICAL_CANCEL_PX
      activeHandler?.end(!cancel)
      // Eat the touchend so synthesized click / focus on the underlying
      // block doesn't fire after the scrub.
      event.preventDefault()
      event.stopPropagation()
    },

    onTouchCancel: (event: TouchEvent) => {
      const tracker = pressByBlockId.get(block.id)
      if (!tracker) return
      if (!findTrackedTouch(event.changedTouches, tracker.identifier)) return

      const wasScrubbing = tracker.scrubbing
      clearTimer(tracker)
      pressByBlockId.delete(block.id)
      if (wasScrubbing) activeHandler?.end(false)
    },
  }
}
