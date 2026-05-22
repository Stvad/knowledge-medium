/**
 * Date scrub gestures:
 *   - mobile: two-finger horizontal drag
 *   - desktop: Ctrl+Alt + horizontal wheel / trackpad / Magic Mouse scroll
 *   - desktop: hold Ctrl+Alt, then use arrows / h-k-j-l to scrub by
 *     day or week
 *
 * Long-press is intentionally NOT used: that gesture belongs to
 * selection / bullet drag (Workflowy convention). The two-finger mobile
 * drag and modifier-gated desktop wheel are rare enough to be
 * intentional and avoid single-finger tap / swipe / scroll conflicts.
 *
 * Coordination contract:
 *   - The React overlay (`DateScrubOverlay`) registers itself as the
 *     `ScrubHandler` on mount and unregisters on unmount. The overlay
 *     owns the runtime + adapter resolution + tooltip rendering.
 *   - This module owns the gesture tracking: per-block touch state,
 *     desktop wheel candidates, thresholds, scrub-active flag.
 *   - When midpoint horizontal travel crosses the activation
 *     threshold (and dominates vertical travel — so a two-finger
 *     vertical scroll doesn't trip it, and a pinch-zoom where the
 *     midpoint stays put doesn't either), we ask the overlay to
 *     start. If it accepts, we cancel the swipe-quick-actions
 *     candidate so the same gesture doesn't also open the swipe menu.
 *   - Either tracked finger lifting ends the mobile scrub. Desktop
 *     wheel and keyboard scrub commit when the user releases Ctrl or
 *     Alt, which is the clearest "let go" signal for a modifier-gated
 *     stream.
 */
import type { TouchEvent, WheelEvent } from 'react'
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
import type { BlockDateAdapter } from './blockDateAdapter.ts'

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
const WHEEL_CANDIDATE_IDLE_MS = 180
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

interface WheelCandidate {
  blockId: string
  block: Block
  startX: number
  startY: number
  dx: number
  dy: number
  clearTimer: number | null
}

interface WheelScrub {
  blockId: string
  dx: number
}

export interface KeyboardScrubTarget {
  block: Block
  adapter?: BlockDateAdapter
}

type KeyboardScrubTargetProvider = () => KeyboardScrubTarget | null

interface KeyboardScrub {
  blockId: string
  deltaDays: number
}

/** First finger landed on a block but the second hasn't arrived yet —
 *  remember it so the eventual second-finger touchstart can promote
 *  to a `MultiTouch` tracker. */
const singleByBlockId = new Map<string, SingleFinger>()
const multiByBlockId = new Map<string, MultiTouch>()
let wheelCandidate: WheelCandidate | null = null
let wheelScrub: WheelScrub | null = null
let keyboardScrub: KeyboardScrub | null = null
let wheelScrubListenersInstalled = false

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
  if (wheelCandidate?.blockId === blockId) clearWheelCandidate()
  if (wheelScrub?.blockId === blockId) finishWheelScrub(false)
  if (keyboardScrub?.blockId === blockId) finishKeyboardScrub(false)
}

const clearWheelCandidate = (): void => {
  if (wheelCandidate?.clearTimer) window.clearTimeout(wheelCandidate.clearTimer)
  wheelCandidate = null
}

const finishWheelScrub = (commit: boolean): void => {
  const current = wheelScrub
  if (!current) return
  wheelScrub = null
  removeWheelScrubListeners()
  activeHandler?.end(commit)
}

const finishKeyboardScrub = (commit: boolean): void => {
  const current = keyboardScrub
  if (!current) return
  keyboardScrub = null
  activeHandler?.end(commit)
}

const isAltReleaseEvent = (event: Pick<KeyboardEvent, 'code' | 'key'>): boolean =>
  event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight'

const isControlReleaseEvent = (event: Pick<KeyboardEvent, 'code' | 'key'>): boolean =>
  event.key === 'Control' || event.code === 'ControlLeft' || event.code === 'ControlRight'

const isCtrlAltReleaseEvent = (event: Pick<KeyboardEvent, 'code' | 'key'>): boolean =>
  isAltReleaseEvent(event) || isControlReleaseEvent(event)

const handleWheelScrubKeyUp = (event: KeyboardEvent): void => {
  if (isCtrlAltReleaseEvent(event)) finishWheelScrub(true)
}

const handleWheelScrubKeyDown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') finishWheelScrub(false)
}

const handleWheelScrubBlur = (): void => {
  finishWheelScrub(false)
}

function installWheelScrubListeners(): void {
  if (wheelScrubListenersInstalled || typeof window === 'undefined') return
  window.addEventListener('keyup', handleWheelScrubKeyUp, true)
  window.addEventListener('keydown', handleWheelScrubKeyDown, true)
  window.addEventListener('blur', handleWheelScrubBlur)
  wheelScrubListenersInstalled = true
}

function removeWheelScrubListeners(): void {
  if (!wheelScrubListenersInstalled || typeof window === 'undefined') return
  window.removeEventListener('keyup', handleWheelScrubKeyUp, true)
  window.removeEventListener('keydown', handleWheelScrubKeyDown, true)
  window.removeEventListener('blur', handleWheelScrubBlur)
  wheelScrubListenersInstalled = false
}

const normalizeWheelDelta = (
  event: Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'>,
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

const scheduleWheelCandidateClear = (): void => {
  if (!wheelCandidate) return
  if (wheelCandidate.clearTimer) window.clearTimeout(wheelCandidate.clearTimer)
  wheelCandidate.clearTimer = window.setTimeout(() => {
    clearWheelCandidate()
  }, WHEEL_CANDIDATE_IDLE_MS)
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

const keyboardDeltaDaysForKey = (event: KeyboardEvent): number | null => {
  switch (event.key) {
    case 'ArrowUp':
      return 1
    case 'ArrowDown':
      return -1
    case 'ArrowRight':
      return 7
    case 'ArrowLeft':
      return -7
  }

  switch (event.key.toLowerCase()) {
    case 'h':
      return 1
    case 'k':
      return -1
    case 'l':
      return 7
    case 'j':
      return -7
    default:
      return null
  }
}

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
    deltaDays: 0,
  }
  keyboardScrub = next
  return next
}

const consumeKeyboardScrubEvent = (event: KeyboardEvent): void => {
  event.preventDefault()
  event.stopPropagation()
}

export const installDateKeyboardScrubListeners = (
  getTarget: KeyboardScrubTargetProvider,
): (() => void) => {
  if (typeof window === 'undefined') return () => undefined

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (keyboardScrub) {
      if (event.key === 'Escape') {
        consumeKeyboardScrubEvent(event)
        finishKeyboardScrub(false)
        return
      }

      const delta = keyboardDeltaDaysForKey(event)
      if (delta === null) return

      consumeKeyboardScrubEvent(event)
      keyboardScrub.deltaDays = clampDeltaDays(keyboardScrub.deltaDays + delta)
      activeHandler?.update(keyboardScrub.deltaDays, false)
      return
    }

    if (!event.ctrlKey || !event.altKey) return

    const delta = keyboardDeltaDaysForKey(event)
    const modifierActivation = isCtrlAltReleaseEvent(event)
    if (delta === null && !modifierActivation) return

    const target = getTarget()
    if (!target) return
    const current = startKeyboardScrub(target)
    if (!current) return

    if (delta === null) return
    consumeKeyboardScrubEvent(event)
    current.deltaDays = clampDeltaDays(current.deltaDays + delta)
    activeHandler?.update(current.deltaDays, false)
  }

  const handleKeyUp = (event: KeyboardEvent): void => {
    if (!keyboardScrub || !isCtrlAltReleaseEvent(event)) return
    consumeKeyboardScrubEvent(event)
    finishKeyboardScrub(true)
  }

  const handleBlur = (): void => {
    finishKeyboardScrub(false)
  }

  window.addEventListener('keydown', handleKeyDown, true)
  window.addEventListener('keyup', handleKeyUp, true)
  window.addEventListener('blur', handleBlur)

  return () => {
    window.removeEventListener('keydown', handleKeyDown, true)
    window.removeEventListener('keyup', handleKeyUp, true)
    window.removeEventListener('blur', handleBlur)
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

export const dateWheelScrubContentSurface: BlockContentSurfaceContribution = context => {
  const {block, uiStateBlock} = context

  return {
    onWheel: (event: WheelEvent) => {
      if (isMobileViewport()) return
      if (!event.ctrlKey || !event.altKey) {
        if (wheelScrub) finishWheelScrub(true)
        return
      }
      // Buttons, editors, and other controls own their wheel behavior.
      // Links and video follow the mobile gesture exemption: the date
      // gesture can still apply to rendered content inside the block.
      if (!isOnInteractiveSurface(event) && isInteractiveContentEvent(event)) {
        clearAllForBlock(block.id)
        return
      }
      if (isBlockEditing(block.id, uiStateBlock)) return

      const {dx, dy} = normalizeWheelDelta(event)
      if (dx === 0 && dy === 0) return

      if (wheelScrub && wheelScrub.blockId !== block.id) {
        finishWheelScrub(true)
      }

      if (!wheelScrub) {
        if (!wheelCandidate || wheelCandidate.blockId !== block.id) {
          clearWheelCandidate()
          wheelCandidate = {
            blockId: block.id,
            block,
            startX: event.clientX,
            startY: event.clientY,
            dx: 0,
            dy: 0,
            clearTimer: null,
          }
        }

        wheelCandidate.dx += dx
        wheelCandidate.dy += dy
        scheduleWheelCandidateClear()

        if (Math.abs(wheelCandidate.dx) <= HORIZONTAL_LOCK_PX) return
        if (Math.abs(wheelCandidate.dx) <= Math.abs(wheelCandidate.dy)) {
          clearWheelCandidate()
          return
        }
        if (!activeHandler) {
          clearWheelCandidate()
          return
        }

        const candidate = wheelCandidate
        const accepted = activeHandler.start({
          block: candidate.block,
          blockId: candidate.blockId,
          startX: candidate.startX,
          startY: candidate.startY,
        })
        clearWheelCandidate()
        if (!accepted) return

        wheelScrub = {
          blockId: candidate.blockId,
          dx: candidate.dx,
        }
        installWheelScrubListeners()
      } else {
        wheelScrub.dx += dx
      }

      event.preventDefault()
      activeHandler?.update(computeDeltaDays(wheelScrub.dx), false)
    },
  }
}
