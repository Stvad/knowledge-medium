/**
 * Swipe recognizer for the continuous-gesture loop — the migration of the
 * bespoke `swipeGesture.ts` touch handlers onto `continuousGestureRecognizersFacet`.
 *
 * It classifies a one-finger horizontal drag and emits NAMED gestures, never
 * action ids:
 *  - leftward drag → `progress` ticks (the toolbar-reveal preview) then a
 *    `swipe-left` commit on release past the trigger distance;
 *  - rightward drag → a `swipe-right` commit on release.
 * The gesture-bound ACTIONS (see actions.ts) bridge those to `SwipeActionMenu`
 * via its existing DOM events — the recognizer no longer dispatches them itself.
 *
 * Single-finger by self-description: a second pointer down means "this isn't a
 * one-finger swipe", so it yields (drops its claim). That keeps it out of the
 * two-finger date-scrub's way without either gesture knowing the other — scroll
 * suppression is `touch-action: pan-y`, arbitration is the loop's.
 */
import type {
  BlockGestureRecognizerContribution,
  GestureEventContext,
  GesturePhaseResult,
  GestureRecognizer,
  GestureSession,
} from '@/extensions/continuousGestures.js'
import { GESTURE_CANCEL, GESTURE_IDLE } from '@/extensions/continuousGestures.js'
import { isInteractiveContentEvent } from '@/extensions/blockInteraction.js'
import { isEditingProp, isFocusedBlock } from '@/data/properties.js'
import type { Block } from '@/data/block'
import type { BlockPointerDependencies } from '@/shortcuts/types.js'
import { swipeProgressTickEvent } from './events.ts'
import { isMobileViewport } from '@/utils/viewport.js'

/** Arbitration key (also the recognizer id). */
export const SWIPE_QUICK_ACTIONS_GESTURE_ID = 'swipe-quick-actions'

/** Min horizontal travel before a release commits open/run. */
export const SWIPE_TRIGGER_PX = 50
/** Once travel exceeds this AND |dx| > |dy|, lock to horizontal. */
const DIRECTION_LOCK_PX = 8
// The menu is mobile-only (SwipeActionMenu early-returns otherwise), so the
// recognizer applies the same gate at gesture time via `isMobileViewport` —
// read live so a resize doesn't leave a stale decision (the factory isn't
// re-run on resize).

const isBlockEditing = (blockId: string, uiStateBlock: Block, renderScopeId?: string): boolean =>
  isFocusedBlock(uiStateBlock, blockId, renderScopeId) &&
  Boolean(uiStateBlock.peekProperty(isEditingProp))

/** Links and video can occupy a large part of readable content; a tap on them
 *  still works (only a completed horizontal swipe preventDefaults), so they are
 *  NOT treated as interactive-content the way buttons/editor are. */
const isSwipeSurfaceEvent = (target: EventTarget | null): boolean => {
  if (typeof Node === 'undefined' || !(target instanceof Node)) return false
  const element = target.nodeType === Node.ELEMENT_NODE ? (target as Element) : target.parentElement
  return Boolean(element?.closest('a[href],video'))
}

interface SwipeStart {
  readonly x: number
  readonly y: number
  readonly pointerId: number
  decided: 'horizontal' | 'vertical' | null
  previewed: boolean
}

/**
 * Build the swiped block's deps. `BlockPointerDependencies` (block + the surface
 * element + render scope) so the gesture-bound actions can dispatch the menu's
 * DOM events on `targetElement` and run with the right block.
 */
const dependenciesFor = (
  context: Parameters<BlockGestureRecognizerContribution>[0],
  ctx: GestureEventContext,
): BlockPointerDependencies => {
  const renderScopeId = typeof context.blockContext?.renderScopeId === 'string'
    ? context.blockContext.renderScopeId
    : undefined
  return {
    block: context.block,
    uiStateBlock: context.uiStateBlock,
    scopeRootId: context.scopeRootId,
    scopeRootForcesOpen: !context.blockContext?.isNestedSurface,
    targetElement: ctx.element,
    ...(renderScopeId ? {renderScopeId} : {}),
  }
}

export const swipeRecognizer: BlockGestureRecognizerContribution = context => {
  const {block, uiStateBlock} = context
  const renderScopeId = typeof context.blockContext?.renderScopeId === 'string'
    ? context.blockContext.renderScopeId
    : undefined
  let start: SwipeStart | null = null

  const editing = (): boolean => isBlockEditing(block.id, uiStateBlock, renderScopeId)

  const recognizer: GestureRecognizer = {
    id: SWIPE_QUICK_ACTIONS_GESTURE_ID,
    // Applicability gate (the menu is mobile-only and a swipe is meaningless on
    // an editing block): the loop drops the recognizer's handlers and its pan-y
    // when this is false, so the handlers below only state per-event ownership.
    // Read live, so a resize / edit toggle is reflected without re-running the
    // factory.
    isEnabled: () => isMobileViewport() && !editing(),
    // pan-y hands horizontal motion to JS while keeping native vertical scroll,
    // so the recognizer doesn't have to preventDefault moves to suppress scroll.
    touchAction: 'pan-y',

    onPointerDown(session: GestureSession, ctx: GestureEventContext): GesturePhaseResult {
      // Touch only; a second pointer means this isn't a one-finger swipe, so
      // yield (drop any claim) and let a multi-finger gesture have it.
      if (ctx.event.pointerType !== 'touch') return GESTURE_IDLE
      if (session.pointers.length > 1) {
        start = null
        return GESTURE_CANCEL
      }
      // Don't intercept gestures starting on buttons / the editor / other
      // interactive descendants; links and video are the exception (taps work).
      if (!isSwipeSurfaceEvent(ctx.event.target) && isInteractiveContentEvent(ctx.event)) {
        return GESTURE_IDLE
      }
      start = {x: session.changed.x, y: session.changed.y, pointerId: session.changed.pointerId, decided: null, previewed: false}
      return GESTURE_IDLE
    },

    onPointerMove(session: GestureSession, ctx: GestureEventContext): GesturePhaseResult {
      if (!start) return GESTURE_IDLE
      // Second finger down mid-drag → not a one-finger swipe; yield.
      if (session.pointers.length > 1) {
        start = null
        return GESTURE_CANCEL
      }
      if (session.changed.pointerId !== start.pointerId) return GESTURE_IDLE

      const dx = session.changed.x - start.x
      const dy = session.changed.y - start.y

      if (start.decided === null && (Math.abs(dx) >= DIRECTION_LOCK_PX || Math.abs(dy) >= DIRECTION_LOCK_PX)) {
        start.decided = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
      }
      // A vertical drag is a scroll — drop the candidate so a later horizontal
      // pivot mid-scroll doesn't surprise the user.
      if (start.decided === 'vertical') {
        start = null
        return GESTURE_CANCEL
      }
      if (start.decided !== 'horizontal') return GESTURE_IDLE

      // Only the leftward (opening) gesture previews; rightward runs a semantic
      // action and needs no intermediate feedback, but still claims the block.
      if (dx < 0) {
        start.previewed = true
        return {status: 'progress', gesture: 'swipe-left', deps: dependenciesFor(context, ctx), event: swipeProgressTickEvent(dx)}
      }
      return {status: 'active'}
    },

    onPointerUp(session: GestureSession, ctx: GestureEventContext): GesturePhaseResult {
      if (!start) return GESTURE_IDLE
      if (session.changed.pointerId !== start.pointerId) return GESTURE_IDLE

      const dx = session.changed.x - start.x
      const dy = session.changed.y - start.y
      start = null

      // Horizontal-only — vertical scrolls and taps are someone else's job.
      if (Math.abs(dx) > Math.abs(dy)) {
        if (dx <= -SWIPE_TRIGGER_PX) {
          return {status: 'commit', gesture: 'swipe-left', deps: dependenciesFor(context, ctx)}
        }
        if (dx >= SWIPE_TRIGGER_PX) {
          return {status: 'commit', gesture: 'swipe-right', deps: dependenciesFor(context, ctx)}
        }
      }
      // Released without committing — `cancel` settles an in-flight preview back.
      return GESTURE_CANCEL
    },

    onPointerCancel(): void {
      // The loop settles any in-flight preview; just drop local state.
      start = null
    },
  }

  return recognizer
}
