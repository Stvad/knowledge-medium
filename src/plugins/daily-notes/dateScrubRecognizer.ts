/**
 * Date-scrub recognizer for the continuous-gesture loop.
 *
 * It classifies a TWO-finger horizontal drag and — like the swipe recognizer —
 * emits NAMED gestures rather than driving the overlay itself:
 *  - on activation it PRE-CHECKS date-shiftability (`pickBlockDateAdapter`), so
 *    it only CLAIMS a block a scrub can act on — no phantom claim of a non-date
 *    block (the claim would otherwise evict rivals / suppress moves for nothing);
 *  - then streams `date-scrub` PROGRESS ticks (the first carries `begin`, the
 *    locked midpoint, so the bound action opens the overlay there);
 *  - and emits a `date-scrub-commit` COMMIT on a committing release, or yields
 *    (`cancel`) on a release/abort that should revert — the loop settles the
 *    in-flight preview back.
 * The gesture-bound ACTIONS (`dateScrubGestureActions.ts`) drive the registered
 * `ScrubHandler` (the `DateScrubOverlay`) — the same singleton the keyboard /
 * wheel scrub already routes through `DATE_SCRUB_CONTEXT` actions. So all three
 * input paths ride the action system; this is just the touch INPUT driver.
 *
 * The loop supplies the pointer SESSION and ARBITRATION, so this no longer
 * tracks `Touch.identifier`s by hand or coordinates with the swipe via
 * `blockGestureConflicts`: the 1-finger swipe yields on the 2nd finger and
 * last-active-wins lets this recognizer claim the block.
 */
import type {
  BlockGestureRecognizerContribution,
  GestureEventContext,
  GesturePhaseResult,
  GesturePointer,
  GestureSession,
} from '@/extensions/continuousGestures.js'
import { GESTURE_CANCEL, GESTURE_IDLE } from '@/extensions/continuousGestures.js'
import { isInteractiveContentEvent } from '@/extensions/blockInteraction.js'
import { isEditingProp, isFocusedBlock } from '@/data/properties.js'
import type { Block } from '@/data/block'
import type { BlockPointerDependencies } from '@/shortcuts/types.js'
import { pickBlockDateAdapter } from './blockDateAdapter.ts'
import {
  computeDeltaDays,
  dateScrubProgressTickEvent,
  DATE_SCRUB_COMMIT_GESTURE,
  DATE_SCRUB_GESTURE,
} from './dateScrubGesture.ts'
import { isMobileViewport } from '@/utils/viewport.js'

/** Arbitration key (also the recognizer id); equals the PROGRESS gesture name. */
export const DATE_SCRUB_GESTURE_ID = DATE_SCRUB_GESTURE

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

  // Per-event ownership: a scrub is a TOUCH gesture, so a mouse/pen pointer
  // isn't ours. The coarse applicability gate (mobile + not editing) lives in
  // `isEnabled` below — the loop won't even call these handlers when it's false.
  // The per-POINTER interactive check is separate again (isEligibleSurface),
  // applied to each anchor finger at lock time so a finger that began on a
  // button/editor can't be half of the pair.
  const isTouch = (ctx: GestureEventContext): boolean => ctx.event.pointerType === 'touch'

  // A finger may anchor a scrub only if it began OFF interactive content (links
  // and video excepted). Touch pointers get implicit capture, so a pointer's
  // session `target` stays its down target — reliable to check at lock time.
  const isEligibleSurface = (target: EventTarget | null): boolean =>
    isScrubSurfaceEvent(target) || !isInteractiveContentEvent({target})

  // The swiped/scrubbed block's deps for the gesture-bound actions: a
  // `block-pointer` action validates `BlockPointerDependencies`. The actions
  // drive the module-singleton overlay, so they only read `block`, but the full
  // shape keeps the deps valid for dispatch (mirrors the swipe recognizer).
  const depsFor = (ctx: GestureEventContext): BlockPointerDependencies => ({
    block,
    uiStateBlock,
    scopeRootId: context.scopeRootId,
    scopeRootForcesOpen: !context.blockContext?.isNestedSurface,
    targetElement: ctx.element,
    ...(renderScopeId ? { renderScopeId } : {}),
  })

  const progressTick = (
    dx: number,
    dy: number,
    ctx: GestureEventContext,
    begin?: { startX: number; startY: number },
  ): GesturePhaseResult => ({
    status: 'progress',
    gesture: DATE_SCRUB_GESTURE,
    deps: depsFor(ctx),
    event: dateScrubProgressTickEvent({
      deltaDays: computeDeltaDays(dx),
      cancelIntent: Math.abs(dy) > VERTICAL_CANCEL_PX,
      ...(begin ? { begin } : {}),
    }),
  })

  // Lock onto the first two ELIGIBLE fingers as the anchor pair, using their LIVE
  // session positions (so a finger that drifted before its partner landed doesn't
  // leave a stale midpoint). A finger resting on an interactive control is skipped,
  // so a two-finger scrub can't start with one finger on a control it would consume.
  const lockAnchor = (session: GestureSession): void => {
    const [a, b] = session.pointers.filter(p => isEligibleSurface(p.target))
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
    // get to process can be a move with both fingers already down. lockAnchor
    // only sets the anchor when two ELIGIBLE fingers are present.
    if (!anchor) {
      if (!isTouch(ctx)) return GESTURE_IDLE
      lockAnchor(session)
    }
    const pair = trackedPair(session)
    if (!pair) return GESTURE_IDLE // <2 eligible fingers, or one tracked finger lifted

    const mid = midpointOf(pair.a, pair.b)
    anchor!.lastMidX = mid.x
    anchor!.lastMidY = mid.y
    const dx = mid.x - anchor!.midX
    const dy = mid.y - anchor!.midY

    if (!scrubbing) {
      // Pre-activation gate: horizontal travel past the lock AND dominating
      // vertical — rejects pinch (midpoint stays put) and two-finger scroll.
      if (Math.abs(dx) <= HORIZONTAL_LOCK_PX || Math.abs(dx) <= Math.abs(dy)) return GESTURE_IDLE
      // Pre-check date-shiftability so we only CLAIM a block a scrub can act on
      // (no phantom claim). `pickBlockDateAdapter` is the same predicate the
      // overlay's `start` re-checks — one source of truth, read in two places.
      const runtime = context.repo.facetRuntime
      if (!runtime || !pickBlockDateAdapter(runtime, block)) {
        anchor = null
        return GESTURE_CANCEL
      }
      scrubbing = true
      // First (activation) tick carries `begin` so the bound action opens the
      // overlay at the lock midpoint before the first update.
      return progressTick(dx, dy, ctx, { startX: anchor!.midX, startY: anchor!.midY })
    }

    return progressTick(dx, dy, ctx)
  }

  return {
    id: DATE_SCRUB_GESTURE_ID,
    // Applicability gate (mobile only, and a scrub is meaningless on an editing
    // block): the loop skips these handlers and drops this pan-y when false, so
    // the handlers below state only per-event ownership. Read live, so a resize
    // / edit toggle is reflected without re-running the factory.
    isEnabled: () => isMobileViewport() && !editing(),
    // pan-y keeps native vertical scroll (so a two-finger vertical scroll isn't
    // ours) while handing horizontal motion to JS; unions with the swipe's pan-y.
    touchAction: 'pan-y',

    onPointerDown(session, ctx) {
      if (!isTouch(ctx)) return GESTURE_IDLE
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

    onPointerUp(session, ctx) {
      if (!anchor) return GESTURE_IDLE
      const isOurs = session.changed.pointerId === anchor.idA || session.changed.pointerId === anchor.idB
      if (!isOurs) return GESTURE_IDLE
      if (!scrubbing) {
        anchor = null
        return GESTURE_IDLE
      }
      // A tracked finger lifted mid-scrub. Commit unless the final vertical
      // travel reads as a cancel.
      const cancel = Math.abs(anchor.lastMidY - anchor.midY) > VERTICAL_CANCEL_PX
      anchor = null
      scrubbing = false
      // cancel → yield so the loop settles the preview back (the reveal action's
      // end(false)); commit → the bound commit action runs end(true). A handled
      // commit also lets the loop swallow the trailing synthesized click.
      return cancel
        ? GESTURE_CANCEL
        : { status: 'commit', gesture: DATE_SCRUB_COMMIT_GESTURE, deps: depsFor(ctx) }
    },

    onPointerCancel(session) {
      // An extra / untracked finger on the same block can receive `pointercancel`
      // (the browser drops it) while both anchored fingers stay down — ignore it,
      // or we'd abort a scrub neither tracked finger left.
      if (!anchor) return GESTURE_IDLE
      if (session.changed.pointerId !== anchor.idA && session.changed.pointerId !== anchor.idB) return GESTURE_IDLE
      // A tracked finger was cancelled. Yield CANCEL so the LOOP settles the
      // in-flight preview now — whichever action won the `date-scrub` progress
      // binding (the default overlay OR a higher-priority override), via that
      // resolved action's settle — rather than poking the overlay directly (which
      // would miss an override) or waiting for the other finger to lift.
      anchor = null
      scrubbing = false
      return GESTURE_CANCEL
    },
  }
}
