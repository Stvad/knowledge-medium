/**
 * Date-scrub recognizer for the continuous-gesture loop — the migration of the
 * bespoke two-finger touch handlers (the old `dateScrubContentSurface`) onto
 * `continuousGestureRecognizersFacet`.
 *
 * It classifies a TWO-finger horizontal drag and drives the registered
 * `ScrubHandler` (the `DateScrubOverlay`) directly — start / update / end —
 * rather than dispatching a named gesture through the action system. The overlay
 * owns the live numeric preview + the accept/reject decision, and the keyboard /
 * wheel scrub path already talks to the same handler, so the recognizer is just
 * the touch INPUT driver for it.
 *
 * The loop supplies the pointer SESSION and ARBITRATION, so this no longer
 * tracks `Touch.identifier`s by hand or coordinate with the swipe via
 * `blockGestureConflicts`: the 1-finger swipe yields on the 2nd finger (a cancel
 * verdict, which settles its preview) and last-active-wins lets this recognizer
 * claim the block.
 */
import type {
  BlockGestureRecognizerContribution,
  GestureEventContext,
  GesturePhaseResult,
  GesturePointer,
  GestureRecognizer,
  GestureSession,
} from '@/extensions/continuousGestures.js'
import { GESTURE_ACTIVE, GESTURE_CANCEL, GESTURE_IDLE } from '@/extensions/continuousGestures.js'
import { isInteractiveContentEvent } from '@/extensions/blockInteraction.js'
import { isEditingProp, isFocusedBlock } from '@/data/properties.js'
import type { Block } from '@/data/block'
import {
  computeDeltaDays,
  endTouchScrub,
  startTouchScrub,
  updateTouchScrub,
} from './dateScrubGesture.ts'

/** Arbitration key (also the recognizer id). */
export const DATE_SCRUB_GESTURE_ID = 'date-scrub'

const MOBILE_BREAKPOINT_QUERY = '(max-width: 767px)'
const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches

/** Midpoint horizontal travel that distinguishes a deliberate scrub from a
 *  pinch (midpoint ~stationary) or a two-finger vertical scroll (dy dominates). */
const HORIZONTAL_LOCK_PX = 10
/** Vertical midpoint travel past which an active scrub reads as "cancel". */
const VERTICAL_CANCEL_PX = 60

const isBlockEditing = (blockId: string, uiStateBlock: Block, renderScopeId?: string): boolean =>
  isFocusedBlock(uiStateBlock, blockId, renderScopeId) &&
  Boolean(uiStateBlock.peekProperty(isEditingProp))

/** Links / video are allowed (a two-finger gesture there is still ours); buttons
 *  and the editor keep their own touch handling. Mirrors the swipe recognizer. */
const isScrubSurfaceEvent = (target: EventTarget | null): boolean => {
  if (typeof Node === 'undefined' || !(target instanceof Node)) return false
  const element = target.nodeType === Node.ELEMENT_NODE ? (target as Element) : target.parentElement
  return Boolean(element?.closest('a[href],video'))
}

interface ScrubAnchor {
  readonly idA: number
  readonly idB: number
  /** Midpoint at lock time — the activation origin the overlay anchors to. */
  readonly midX: number
  readonly midY: number
  /** Latest midpoint, tracked each move so the release can read final position. */
  lastMidX: number
  lastMidY: number
}

const midpointOf = (a: GesturePointer, b: GesturePointer): { x: number; y: number } => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
})

export const dateScrubRecognizer: BlockGestureRecognizerContribution = context => {
  const { block, uiStateBlock } = context
  const renderScopeId = typeof context.blockContext?.renderScopeId === 'string'
    ? context.blockContext.renderScopeId
    : undefined

  let anchor: ScrubAnchor | null = null
  let scrubbing = false

  const editing = (): boolean => isBlockEditing(block.id, uiStateBlock, renderScopeId)

  // Tear down. Ends the overlay (commit-or-revert) if a scrub was live.
  const reset = (commit: boolean): void => {
    if (scrubbing) endTouchScrub(commit)
    anchor = null
    scrubbing = false
  }

  // Touch + mobile only, off the editor / interactive descendants (links + video
  // excepted), not while this block is being edited.
  const canTrack = (ctx: GestureEventContext): boolean =>
    ctx.event.pointerType === 'touch' &&
    isMobileViewport() &&
    !(isInteractiveContentEvent(ctx.event) && !isScrubSurfaceEvent(ctx.event.target)) &&
    !editing()

  // Lock onto the first two fingers as the anchor pair, using their LIVE session
  // positions (so a finger that drifted before its partner landed doesn't leave
  // a stale midpoint).
  const lockAnchor = (session: GestureSession): void => {
    const [a, b] = session.pointers
    if (!a || !b) return
    const mid = midpointOf(a, b)
    anchor = { idA: a.pointerId, idB: b.pointerId, midX: mid.x, midY: mid.y, lastMidX: mid.x, lastMidY: mid.y }
  }

  const trackedPair = (session: GestureSession): { a: GesturePointer; b: GesturePointer } | null => {
    if (!anchor) return null
    const a = session.pointers.find(p => p.pointerId === anchor!.idA)
    const b = session.pointers.find(p => p.pointerId === anchor!.idB)
    return a && b ? { a, b } : null
  }

  const onTwoFinger = (session: GestureSession, ctx: GestureEventContext): GesturePhaseResult => {
    // Anchor lazily: the loop may not have run our onPointerDown for the 2nd
    // finger if a rival owned the block when it landed, so the first event we
    // get to process can be a move with both fingers already down.
    if (!anchor) {
      if (!canTrack(ctx)) return GESTURE_IDLE
      lockAnchor(session)
    }
    const pair = trackedPair(session)
    if (!pair) return GESTURE_IDLE // one tracked finger missing — up settles it

    const mid = midpointOf(pair.a, pair.b)
    anchor!.lastMidX = mid.x
    anchor!.lastMidY = mid.y
    const dx = mid.x - anchor!.midX
    const dy = mid.y - anchor!.midY

    if (!scrubbing) {
      // Pre-activation gate: horizontal travel past the lock AND dominating
      // vertical — rejects pinch (midpoint stays put) and two-finger scroll.
      if (Math.abs(dx) <= HORIZONTAL_LOCK_PX || Math.abs(dx) <= Math.abs(dy)) return GESTURE_IDLE
      if (editing()) return GESTURE_IDLE
      const accepted = startTouchScrub({
        block,
        blockId: block.id,
        startX: anchor!.midX,
        startY: anchor!.midY,
      })
      if (!accepted) {
        // Not date-shiftable — yield the block (drop our claim and state).
        anchor = null
        return GESTURE_CANCEL
      }
      scrubbing = true
    }

    updateTouchScrub(computeDeltaDays(dx), Math.abs(dy) > VERTICAL_CANCEL_PX)
    return GESTURE_ACTIVE
  }

  const recognizer: GestureRecognizer = {
    id: DATE_SCRUB_GESTURE_ID,
    // pan-y keeps native vertical scroll (so a two-finger vertical scroll isn't
    // ours) while handing horizontal motion to JS; unions with the swipe's pan-y.
    touchAction: 'pan-y',

    onPointerDown(session, ctx) {
      if (!canTrack(ctx)) return GESTURE_IDLE
      if (!anchor && session.pointers.length >= 2) lockAnchor(session)
      return GESTURE_IDLE
    },

    onPointerMove(session, ctx) {
      if (session.pointers.length < 2) {
        // Dropped below two fingers before activating — abandon the candidate.
        if (!scrubbing) anchor = null
        return GESTURE_IDLE
      }
      return onTwoFinger(session, ctx)
    },

    onPointerUp(session) {
      if (!anchor) return GESTURE_IDLE
      const isOurs = session.changed.pointerId === anchor.idA || session.changed.pointerId === anchor.idB
      if (!isOurs) return GESTURE_IDLE
      if (!scrubbing) {
        anchor = null
        return GESTURE_IDLE
      }
      // A tracked finger lifted mid-scrub → end. Commit unless the final
      // vertical travel reads as a cancel.
      const cancel = Math.abs(anchor.lastMidY - anchor.midY) > VERTICAL_CANCEL_PX
      reset(!cancel)
      // Claim the up (prevent: true) so the loop suppresses the synthesized
      // click on the block after the scrub.
      return GESTURE_ACTIVE
    },

    onPointerCancel() {
      reset(false)
    },
  }

  return recognizer
}
