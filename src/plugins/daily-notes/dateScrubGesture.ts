/**
 * Date scrub gestures:
 *   - mobile: two-finger horizontal drag
 *   - desktop: hold `s` in NORMAL_MODE to enter scrub mode;
 *     arrows / h-j-k-l scrub by day or week; the wheel also feeds the
 *     same running scrub while armed; release `s` commits; Escape
 *     cancels. Routed through the action system as `DATE_SCRUB_CONTEXT`
 *     — see `dateScrubActions.ts`. Both keyboard and wheel scrub commit
 *     via the context's `s`-keyup action.
 *
 * Long-press is intentionally NOT used: that gesture belongs to
 * selection / bullet drag (Workflowy convention). The two-finger mobile
 * drag is rare enough to be intentional and avoid single-finger tap /
 * swipe / scroll conflicts.
 *
 * Coordination contract:
 *   - The React overlay (`DateScrubOverlay`) registers itself as the
 *     `ScrubHandler` on mount and unregisters on unmount. The overlay
 *     owns the runtime + adapter resolution + tooltip rendering.
 *   - This module owns the gesture tracking: per-block touch state,
 *     module-level keyboard/wheel scrub state, thresholds, scrub-active flag.
 *   - When midpoint horizontal travel crosses the activation
 *     threshold (and dominates vertical travel — so a two-finger
 *     vertical scroll doesn't trip it, and a pinch-zoom where the
 *     midpoint stays put doesn't either), we ask the overlay to
 *     start. If it accepts, we cancel the swipe-quick-actions
 *     candidate so the same gesture doesn't also open the swipe menu.
 *   - Either tracked finger lifting ends the mobile scrub.
 */
import type { TouchEvent } from 'react'
import {
  isInteractiveContentEvent,
  type BlockContentSurfaceContribution,
} from '@/extensions/blockInteraction.js'
import {
  claimBlockGesture,
  releaseBlockGesture,
} from '@/extensions/blockGestureConflicts.js'
import {
  focusedBlockIdProp,
  isEditingProp,
} from '@/data/properties.js'
import type { Block } from '@/data/block'
import type { BlockDateAdapter } from './blockDateAdapter.ts'

/** Identifier for the block-gesture-conflicts facet contribution. Used
 *  to claim the per-block gesture slot when touch scrub activates and
 *  to route eviction calls when another gesture claims the slot. */
export const DATE_SCRUB_GESTURE_ID = 'date-scrub'

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
/** Pixels of scrub motion per ISO day. Picked so that ±2 weeks fits
 *  inside half a thumb-arc on a phone (~200px = 14 days). */
const PIXELS_PER_DAY = 14
const WHEEL_LINE_PX = 16
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
  /** Optional adapter override for input surfaces with fresher state
   *  than `block.peek()` (notably a live CodeMirror editor). */
  adapter?: BlockDateAdapter
  /** Midpoint between the two locked fingers at activation time.
   *  The overlay anchors its pill near this point. */
  startX: number
  startY: number
}

export interface DateScrubDraftPreview {
  label: string
  value: string
  detail?: string
}

export interface DateScrubDraft<Payload = unknown> {
  id: string
  currentIso: string
  preview: DateScrubDraftPreview
  payload?: Payload
  shiftDate: (deltaDays: number) => DateScrubDraft<Payload>
  commit: () => void | Promise<void>
}

export interface ScrubHandler {
  /** Returns true if the overlay accepted the scrub (block is
   *  date-shiftable). Returning false makes the gesture revert as if
   *  no activation happened. */
  start: (args: ScrubStartArgs) => boolean
  update: (deltaDays: number, intentCancel: boolean) => void
  stage?: (blockId: string, draft: DateScrubDraft) => boolean
  getDraft?: (blockId: string) => DateScrubDraft | null
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

export interface KeyboardScrubTarget {
  block: Block
  adapter?: BlockDateAdapter
}

interface KeyboardScrub {
  blockId: string
  keyDeltaDays: number
  wheelPx: number
}

/** First finger landed on a block but the second hasn't arrived yet —
 *  remember it so the eventual second-finger touchstart can promote
 *  to a `MultiTouch` tracker. */
const singleByBlockId = new Map<string, SingleFinger>()
const multiByBlockId = new Map<string, MultiTouch>()
let keyboardScrub: KeyboardScrub | null = null

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

const computeDeltaDays = (offsetPx: number): number => {
  const raw = Math.round(offsetPx / PIXELS_PER_DAY)
  if (raw > MAX_OFFSET_DAYS) return MAX_OFFSET_DAYS
  if (raw < MIN_OFFSET_DAYS) return MIN_OFFSET_DAYS
  return raw
}

const clearAllForBlock = (blockId: string): void => {
  singleByBlockId.delete(blockId)
  multiByBlockId.delete(blockId)
  if (keyboardScrub?.blockId === blockId) finishKeyboardScrub(false)
}

/** Drop any in-flight touch-scrub state for `blockId`. Registered as
 *  this gesture's `onCancel` on the block-gesture-conflicts facet so
 *  another gesture taking the slot tears down the overlay if scrub
 *  had already started. Keyboard / wheel scrub deliberately stays
 *  outside the conflict facet (no touch-level competitor) so it isn't
 *  touched here. */
export const cancelDateScrubForBlock = (blockId: string): void => {
  const multi = multiByBlockId.get(blockId)
  singleByBlockId.delete(blockId)
  multiByBlockId.delete(blockId)
  if (multi?.scrubbing) activeHandler?.end(false)
}

const finishKeyboardScrub = (commit: boolean): void => {
  const current = keyboardScrub
  if (!current) return
  keyboardScrub = null
  activeHandler?.end(commit)
}

/** Exposed to the `DATE_SCRUB_CONTEXT` commit/cancel actions. Idempotent
 *  — calling when no scrub is active is a no-op. */
export const endKeyboardScrub = finishKeyboardScrub

const normalizeWheelDelta = (
  event: Pick<globalThis.WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'>,
): {dx: number; dy: number} => {
  const multiplier = event.deltaMode === 1
    ? WHEEL_LINE_PX
    : event.deltaMode === 2
      ? (typeof window === 'undefined' ? 800 : window.innerWidth)
      : 1
  return {
    dx: event.deltaX * multiplier,
    dy: event.deltaY * multiplier,
  }
}

const scrubPixelsForWheelDelta = (
  event: Pick<globalThis.WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'>,
): number => {
  const {dx, dy} = normalizeWheelDelta(event)
  // Browsers commonly remap Shift+wheel vertical motion into deltaX.
  const axisPx = dy !== 0 ? dy : dx
  return -axisPx
}

const escapeCssIdent = (value: string): string => {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

const keyboardScrubAnchorPoint = (blockId: string): {x: number; y: number} => {
  const fallback = {
    x: typeof window === 'undefined' ? 0 : window.innerWidth / 2,
    y: typeof window === 'undefined' ? 0 : window.innerHeight / 2,
  }
  if (typeof document === 'undefined') return fallback

  const selector = `[data-block-id="${escapeCssIdent(blockId)}"]`
  const activeElement = document.activeElement
  const activeBlock = activeElement instanceof Element
    ? activeElement.closest<HTMLElement>(selector)
    : null
  const blockElement = activeBlock ?? document.querySelector<HTMLElement>(selector)
  const anchor = blockElement?.querySelector<HTMLElement>('.block-content') ?? blockElement
  if (!anchor) return fallback

  const rect = anchor.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return fallback
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  }
}

const keyboardScrubTotalDays = (scrub: KeyboardScrub): number =>
  clampDeltaDays(scrub.keyDeltaDays + computeDeltaDays(scrub.wheelPx))

const clampDeltaDays = (deltaDays: number): number => {
  if (deltaDays > MAX_OFFSET_DAYS) return MAX_OFFSET_DAYS
  if (deltaDays < MIN_OFFSET_DAYS) return MIN_OFFSET_DAYS
  return deltaDays
}

const startKeyboardScrub = (target: KeyboardScrubTarget): KeyboardScrub | null => {
  if (keyboardScrub) return keyboardScrub
  if (!activeHandler) return null

  const point = keyboardScrubAnchorPoint(target.block.id)
  const accepted = activeHandler.start({
    block: target.block,
    blockId: target.block.id,
    adapter: target.adapter,
    startX: point.x,
    startY: point.y,
  })
  if (!accepted) return null

  const next = {
    blockId: target.block.id,
    keyDeltaDays: 0,
    wheelPx: 0,
  }
  keyboardScrub = next
  return next
}

/** Exposed for the `DATE_SCRUB_CONTEXT` enter action: starts a keyboard
 *  scrub on `target` if the overlay accepts (block is date-shiftable).
 *  Returns true on success — the action handler then activates the
 *  modal context. */
export const startKeyboardScrubForTarget = (target: KeyboardScrubTarget): boolean =>
  startKeyboardScrub(target) !== null

/** Exposed for the `DATE_SCRUB_CONTEXT` movement actions: applies a day
 *  delta to the running scrub. No-op if no scrub is active (the modal
 *  context's invariant should prevent this, but the action handlers
 *  can't atomically observe it). */
export const applyKeyboardScrubDelta = (deltaDays: number): void => {
  if (!keyboardScrub) return
  keyboardScrub.keyDeltaDays = clampDeltaDays(keyboardScrub.keyDeltaDays + deltaDays)
  activeHandler?.update(keyboardScrubTotalDays(keyboardScrub), false)
}

export const stageDateScrubDraft = (
  blockId: string,
  draft: DateScrubDraft,
): boolean => activeHandler?.stage?.(blockId, draft) ?? false

export const getDateScrubDraft = (
  blockId: string,
): DateScrubDraft | null => activeHandler?.getDraft?.(blockId) ?? null

const updateKeyboardScrubByWheel = (
  scrub: KeyboardScrub,
  event: globalThis.WheelEvent,
): void => {
  const deltaPx = scrubPixelsForWheelDelta(event)
  if (deltaPx === 0) return
  event.preventDefault()
  event.stopPropagation()
  scrub.wheelPx += deltaPx
  activeHandler?.update(keyboardScrubTotalDays(scrub), false)
}

/** Window listeners the keyboard-scrub state machine needs that don't
 *  fit the action system: wheel events as a feeder while a scrub is
 *  already armed (no wheel-trigger primitive on the action substrate),
 *  and window blur to cancel.
 *
 *  Activation, movement, commit, and cancel are all routed through
 *  `DATE_SCRUB_CONTEXT` actions (see dateScrubActions.ts). The wheel
 *  here is purely a feeder — it never starts a scrub on its own, only
 *  contributes deltas while one is armed via hold-`s`. */
export const installDateScrubAuxListeners = (): (() => void) => {
  if (typeof window === 'undefined') return () => undefined

  const handleBlur = (): void => {
    finishKeyboardScrub(false)
  }

  const handleWheel = (event: globalThis.WheelEvent): void => {
    if (!keyboardScrub) return
    updateKeyboardScrubByWheel(keyboardScrub, event)
  }

  window.addEventListener('blur', handleBlur)
  window.addEventListener('wheel', handleWheel, {capture: true, passive: false})

  return () => {
    window.removeEventListener('blur', handleBlur)
    window.removeEventListener('wheel', handleWheel, true)
    finishKeyboardScrub(false)
  }
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
          // Look up the first finger's CURRENT position (not its
          // stored touchstart snapshot). If finger A had drifted
          // between landing and finger B arriving — common when the
          // user was mid-scroll / repositioning — anchoring on the
          // stale snapshot would put the midpoint somewhere finger A
          // no longer is. The very next touchmove would then produce
          // a fake `dx` against that stale anchor and falsely
          // activate scrub.
          const liveA = findTouchById(event.touches, single.id)
          const ax = liveA?.clientX ?? single.x
          const ay = liveA?.clientY ?? single.y
          const startMidX = (ax + newFinger.x) / 2
          const startMidY = (ay + newFinger.y) / 2
          multiByBlockId.set(block.id, {
            blockId: block.id,
            a: {id: single.id, x: ax, y: ay},
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
        // Claim the block-level gesture slot. Any other gesture
        // holding it (notably the single-finger swipe candidate
        // recorded from the first finger landing) gets its onCancel
        // fired, which drops its in-flight state so the eventual
        // touchend doesn't fire its semantic action on top of our
        // scrub. Routed via the block-gesture-conflicts facet so we
        // don't need to know what other gestures exist.
        claimBlockGesture(
          block.repo.facetRuntime,
          block.id,
          DATE_SCRUB_GESTURE_ID,
        )
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
      releaseBlockGesture(block.id, DATE_SCRUB_GESTURE_ID)
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
      releaseBlockGesture(block.id, DATE_SCRUB_GESTURE_ID)
      if (wasScrubbing) activeHandler?.end(false)
    },
  }
}
