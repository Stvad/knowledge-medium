/**
 * Two-finger horizontal drag → scrub-to-date gesture (option-2
 * prototype). Long-press is intentionally NOT used: that gesture
 * belongs to selection / bullet drag (Workflowy convention). A
 * two-finger drag is rare enough to be unambiguously intentional and
 * doesn't conflict with any single-finger gesture (tap, swipe,
 * scroll, long-press selection).
 *
 * Coordination contract:
 *   - The React overlay (`DateScrubOverlay`) registers itself as the
 *     `ScrubHandler` on mount and unregisters on unmount. The overlay
 *     owns the runtime + adapter resolution + tooltip rendering.
 *   - This module owns the touch tracking: per-block "two fingers
 *     locked" state, midpoint motion thresholds, scrub-active flag.
 *   - When midpoint horizontal travel crosses the activation
 *     threshold (and dominates vertical travel — so a two-finger
 *     vertical scroll doesn't trip it, and a pinch-zoom where the
 *     midpoint stays put doesn't either), we ask the overlay to
 *     start. If it accepts, we cancel the swipe-quick-actions
 *     candidate so the same gesture doesn't also open the swipe menu.
 *   - Either tracked finger lifting ends the scrub.
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

/** Midpoint horizontal travel that distinguishes "user is scrubbing"
 *  from "user is pinching / scrolling / just landed two fingers". A
 *  pinch keeps the midpoint roughly stationary; a vertical scroll
 *  moves it vertically; only a deliberate horizontal pan trips this. */
const HORIZONTAL_LOCK_PX = 10
/** Pixels of horizontal drag per ISO day. Picked so that ±2 weeks fits
 *  inside half a thumb-arc on a phone (~200px = 14 days). */
const PIXELS_PER_DAY = 14
/** Vertical midpoint travel above this — once scrub is active —
 *  snaps the gesture into "cancel" intent. Released past this point
 *  reverts. */
const VERTICAL_CANCEL_PX = 60
/** Caps so a wild horizontal swing across the screen doesn't put the
 *  date a year out by accident. The user can still tap the calendar
 *  chips in the swipe-menu Reschedule sheet for big jumps. */
const MAX_OFFSET_DAYS = 90
const MIN_OFFSET_DAYS = -90

export interface ScrubStartArgs {
  block: Block
  blockId: string
  /** Midpoint between the two locked fingers at activation time.
   *  The overlay anchors its pill near this point. */
  startX: number
  startY: number
}

export interface ScrubHandler {
  /** Returns true if the overlay accepted the scrub (block is
   *  date-shiftable). Returning false makes the gesture revert as if
   *  no activation happened. */
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

interface FingerSnapshot {
  id: number
  x: number
  y: number
}

interface SingleFinger extends FingerSnapshot {
  blockId: string
}

interface MultiTouch {
  blockId: string
  a: FingerSnapshot
  b: FingerSnapshot
  startMidX: number
  startMidY: number
  /** Updated on each touchmove — touchend uses it to read final
   *  midpoint position without recomputing from the (possibly
   *  partial) `event.touches` list, since one of our fingers may
   *  already be in `changedTouches`. */
  lastMidX: number
  lastMidY: number
  scrubbing: boolean
}

/** First finger landed on a block but the second hasn't arrived yet —
 *  remember it so the eventual second-finger touchstart can promote
 *  to a `MultiTouch` tracker. */
const singleByBlockId = new Map<string, SingleFinger>()
const multiByBlockId = new Map<string, MultiTouch>()

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

const findTouchById = (
  list: { length: number; [index: number]: { identifier: number } } | undefined | null,
  id: number,
): { clientX: number; clientY: number } | null => {
  if (!list) return null
  for (let i = 0; i < list.length; i++) {
    const entry = list[i] as unknown as { identifier: number; clientX: number; clientY: number }
    if (entry.identifier === id) return entry
  }
  return null
}

const computeDeltaDays = (dx: number): number => {
  const raw = Math.round(dx / PIXELS_PER_DAY)
  if (raw > MAX_OFFSET_DAYS) return MAX_OFFSET_DAYS
  if (raw < MIN_OFFSET_DAYS) return MIN_OFFSET_DAYS
  return raw
}

const clearAllForBlock = (blockId: string): void => {
  singleByBlockId.delete(blockId)
  multiByBlockId.delete(blockId)
}

export const dateScrubContentSurface: BlockContentSurfaceContribution = context => {
  const {block, uiStateBlock} = context

  return {
    onTouchStart: (event: TouchEvent) => {
      if (!isMobileViewport()) return
      // Same exemption set as the swipe gesture — buttons / editor /
      // CodeMirror shouldn't co-opt their own touch handling. Links
      // and video are allowed (a two-finger gesture there is still
      // ours).
      if (!isOnInteractiveSurface(event) && isInteractiveContentEvent(event)) {
        clearAllForBlock(block.id)
        return
      }
      if (isBlockEditing(block.id, uiStateBlock)) return

      for (let i = 0; i < event.changedTouches.length; i++) {
        const t = event.changedTouches[i]
        const newFinger: FingerSnapshot = {id: t.identifier, x: t.clientX, y: t.clientY}

        // Already locked on two fingers — ignore any third+ finger
        // landing on the block.
        if (multiByBlockId.has(block.id)) continue

        const single = singleByBlockId.get(block.id)
        if (!single) {
          singleByBlockId.set(block.id, {blockId: block.id, ...newFinger})
        } else if (single.id !== newFinger.id) {
          // Second finger arrived — promote to a multi-touch tracker.
          const startMidX = (single.x + newFinger.x) / 2
          const startMidY = (single.y + newFinger.y) / 2
          multiByBlockId.set(block.id, {
            blockId: block.id,
            a: {id: single.id, x: single.x, y: single.y},
            b: newFinger,
            startMidX,
            startMidY,
            lastMidX: startMidX,
            lastMidY: startMidY,
            scrubbing: false,
          })
          singleByBlockId.delete(block.id)
        }
      }
    },

    onTouchMove: (event: TouchEvent) => {
      const multi = multiByBlockId.get(block.id)
      if (!multi) return

      const aNow = findTouchById(event.touches, multi.a.id)
      const bNow = findTouchById(event.touches, multi.b.id)
      // Either tracked finger is missing from active touches (lifted
      // between events) — leave the touchend handler to settle this.
      if (!aNow || !bNow) return

      const midX = (aNow.clientX + bNow.clientX) / 2
      const midY = (aNow.clientY + bNow.clientY) / 2
      multi.lastMidX = midX
      multi.lastMidY = midY

      const dx = midX - multi.startMidX
      const dy = midY - multi.startMidY

      if (!multi.scrubbing) {
        // Pre-activation gate. We require horizontal travel > the
        // lock threshold AND > vertical travel. This naturally
        // rejects pinch-zoom (midpoint stays near origin) and
        // two-finger vertical scroll (dy dominates).
        if (Math.abs(dx) <= HORIZONTAL_LOCK_PX) return
        if (Math.abs(dx) <= Math.abs(dy)) return
        if (!activeHandler) return
        const accepted = activeHandler.start({
          block,
          blockId: block.id,
          startX: multi.startMidX,
          startY: multi.startMidY,
        })
        if (!accepted) {
          // Block isn't date-shiftable — drop our state so we don't
          // keep eating touches on it.
          multiByBlockId.delete(block.id)
          return
        }
        multi.scrubbing = true
        // The first finger is also being tracked by the swipe
        // gesture; cancel its candidate so the eventual touchend
        // doesn't open the swipe menu on top of our scrub.
        cancelSwipeCandidate(block.id)
      }

      // Active scrub: feed the overlay the candidate offset and the
      // cancel-intent flag. preventDefault stops the page scrolling
      // under the user's drag.
      event.preventDefault()
      const intentCancel = Math.abs(dy) > VERTICAL_CANCEL_PX
      activeHandler?.update(computeDeltaDays(dx), intentCancel)
    },

    onTouchEnd: (event: TouchEvent) => {
      // Clean up a single-finger candidate if its touch is ending and
      // it never got promoted.
      const single = singleByBlockId.get(block.id)
      if (single && findTouchById(event.changedTouches, single.id)) {
        singleByBlockId.delete(block.id)
      }

      const multi = multiByBlockId.get(block.id)
      if (!multi) return

      // Either of our two tracked fingers lifting ends the scrub —
      // we lose the midpoint anchor once we don't have both.
      const endedA = !!findTouchById(event.changedTouches, multi.a.id)
      const endedB = !!findTouchById(event.changedTouches, multi.b.id)
      if (!endedA && !endedB) return

      const wasScrubbing = multi.scrubbing
      multiByBlockId.delete(block.id)
      if (!wasScrubbing) return

      const dy = multi.lastMidY - multi.startMidY
      const cancel = Math.abs(dy) > VERTICAL_CANCEL_PX
      activeHandler?.end(!cancel)
      // Eat the touchend so synthesized click / focus on the
      // underlying block doesn't fire after the scrub.
      event.preventDefault()
      event.stopPropagation()
    },

    onTouchCancel: (event: TouchEvent) => {
      const single = singleByBlockId.get(block.id)
      if (single && findTouchById(event.changedTouches, single.id)) {
        singleByBlockId.delete(block.id)
      }

      const multi = multiByBlockId.get(block.id)
      if (!multi) return
      const endedA = !!findTouchById(event.changedTouches, multi.a.id)
      const endedB = !!findTouchById(event.changedTouches, multi.b.id)
      if (!endedA && !endedB) return

      const wasScrubbing = multi.scrubbing
      multiByBlockId.delete(block.id)
      if (wasScrubbing) activeHandler?.end(false)
    },
  }
}
