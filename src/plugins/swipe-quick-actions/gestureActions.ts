/**
 * The swipe gesture's BEHAVIOR, as actions bound to the named gestures the
 * recognizer emits. The recognizer (swipeRecognizer.ts) only classifies motion
 * and emits `swipe-left` (progress + commit); these actions are what those
 * gestures DO — and they're ordinary `block-pointer` actions, so context
 * priority can override them (a display surface could bind its own `swipe-left`
 * preview/open that shadows these).
 *
 * Both bridge to `SwipeActionMenu` via its existing DOM events: the menu owns
 * its open/preview React state and listens on the panel root, so the action
 * just dispatches on `deps.targetElement` (the swiped block's surface, which
 * bubbles up to the panel). This is the seam the migration inserts — recognizer
 * → action (resolve by context priority) → menu — replacing the recognizer
 * dispatching those DOM events itself.
 */
import type { ActionConfig } from '@/shortcuts/types.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { GESTURE_PROGRESS_CANCEL_EVENT } from '@/shortcuts/gestureAction.js'
import {
  dispatchSwipeQuickActionMenuEvent,
  dispatchSwipeQuickActionProgressEvent,
  SWIPE_QUICK_ACTION_CLOSE_EVENT,
  SWIPE_QUICK_ACTION_OPEN_EVENT,
  type SwipeProgressTickDetail,
} from './events.ts'

/**
 * `swipe-left` PROGRESS: stream the live toolbar-reveal. Receives the
 * recognizer's tick (a CustomEvent carrying `dx`) on each move and the
 * synthesized settle trigger on a non-committing release — bridged to the menu's
 * progress event as `active` / `cancel`.
 */
export const swipeLeftRevealAction: ActionConfig<typeof ActionContextTypes.BLOCK_POINTER> = {
  id: 'swipe-quick-actions.reveal',
  description: 'Swipe left: reveal the quick-action toolbar',
  context: ActionContextTypes.BLOCK_POINTER,
  gestureBinding: {gesture: 'swipe-left', phase: 'progress'},
  handler: ({block, targetElement, renderScopeId}, trigger) => {
    const event = trigger as CustomEvent<SwipeProgressTickDetail>
    const settling = event.type === GESTURE_PROGRESS_CANCEL_EVENT
    const dx = settling ? 0 : event.detail.dx
    dispatchSwipeQuickActionProgressEvent(
      targetElement,
      block.id,
      dx,
      settling ? 'cancel' : 'active',
      renderScopeId,
    )
  },
}

/** `swipe-left` COMMIT: open the quick-action menu for the swiped block. */
export const swipeLeftOpenAction: ActionConfig<typeof ActionContextTypes.BLOCK_POINTER> = {
  id: 'swipe-quick-actions.open',
  description: 'Swipe left: open the quick-action menu',
  context: ActionContextTypes.BLOCK_POINTER,
  gestureBinding: {gesture: 'swipe-left'},
  handler: ({block, targetElement, renderScopeId}) => {
    dispatchSwipeQuickActionMenuEvent(targetElement, SWIPE_QUICK_ACTION_OPEN_EVENT, block.id, renderScopeId)
  },
}

/**
 * `swipe-right` COMMIT (fallback): close an open quick-action menu. Restores the
 * fallback the bespoke `swipeGesture.ts` had — a right-swipe on content closed
 * the open menu when nothing else claimed `swipe-right`. The todo plugin also
 * binds `swipe-right` (cycle a todo); this is a SEPARATE candidate in the same
 * run-until-handled gesture, so ordering matters: it's DECLINABLE. The CLOSE
 * event is `cancelable` and the menu calls `preventDefault` only when a menu for
 * this block was actually open, so `dispatchEvent` returns false in that case
 * (a menu closed → this action handled it, return void) and true otherwise (no
 * menu was open → return false to DECLINE, so the loop falls through to the todo
 * cycle action). Net: a right-swipe cycles a todo when no menu is open, and
 * closes the menu when one is — and disabling Todo still leaves the close
 * affordance intact.
 */
export const swipeRightCloseAction: ActionConfig<typeof ActionContextTypes.BLOCK_POINTER> = {
  id: 'swipe-quick-actions.close',
  description: 'Swipe right: close the quick-action menu',
  context: ActionContextTypes.BLOCK_POINTER,
  gestureBinding: {gesture: 'swipe-right'},
  handler: ({block, targetElement, renderScopeId}) => {
    // dispatchEvent returns true when nothing cancelled it — i.e. no menu was
    // open for this block — so decline and let the todo cycle action run.
    if (dispatchSwipeQuickActionMenuEvent(
      targetElement,
      SWIPE_QUICK_ACTION_CLOSE_EVENT,
      block.id,
      renderScopeId,
    )) {
      return false
    }
  },
}

export const swipeGestureActions: readonly ActionConfig[] = [
  swipeLeftRevealAction,
  swipeLeftOpenAction,
  swipeRightCloseAction,
]
