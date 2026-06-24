/**
 * The two-finger date-scrub's BEHAVIOR, as actions bound to the named gestures
 * the recognizer emits — the touch path's join onto the action spine, mirroring
 * swipe-quick-actions' `gestureActions.ts` and matching how the keyboard/wheel
 * scrub already routes through `DATE_SCRUB_CONTEXT` actions.
 *
 * The recognizer (`dateScrubRecognizer.ts`) classifies the drag, pre-checks
 * date-shiftability (so it only claims a block a scrub can act on), and emits
 * `date-scrub` PROGRESS ticks + a `date-scrub-commit` COMMIT. These actions
 * drive the registered `ScrubHandler` (the `DateScrubOverlay`) — the same
 * singleton the keyboard path talks to — via the touch-scrub wrappers:
 *   - progress tick → `start` on the first (begin) tick, then `update`;
 *   - progress settle (a non-committing release / abort) → `end(false)`;
 *   - commit → `end(true)`.
 * They're ordinary `block-pointer` actions, so a higher-priority context could
 * override the preview/commit the same way it can for swipe.
 */
import type { ActionConfig } from '@/shortcuts/types.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { GESTURE_PROGRESS_CANCEL_EVENT } from '@/shortcuts/gestureAction.js'
import {
  DATE_SCRUB_COMMIT_GESTURE,
  DATE_SCRUB_GESTURE,
  endTouchScrub,
  startTouchScrub,
  updateTouchScrub,
  type DateScrubProgressDetail,
} from './dateScrubGesture.ts'

/**
 * `date-scrub` PROGRESS: drive the overlay's live preview. The first (begin)
 * tick opens the overlay at the locked midpoint, every tick streams the day
 * delta, and the synthesized settle on a non-committing release / pointercancel
 * reverts it.
 */
export const dateScrubRevealAction: ActionConfig<typeof ActionContextTypes.BLOCK_POINTER> = {
  id: 'daily-notes.date-scrub.reveal',
  description: 'Two-finger date scrub: live date preview',
  context: ActionContextTypes.BLOCK_POINTER,
  gestureBinding: {gesture: DATE_SCRUB_GESTURE, phase: 'progress'},
  handler: ({block}, trigger) => {
    // The terminal settle arrives as the dispatcher's cancel event (no scrub
    // detail) — revert and stop. Active ticks carry the recognizer's payload.
    if ((trigger as Event).type === GESTURE_PROGRESS_CANCEL_EVENT) {
      endTouchScrub(false)
      return
    }
    const {deltaDays, cancelIntent, begin} = (trigger as CustomEvent<DateScrubProgressDetail>).detail
    // First tick: open the overlay at the activation anchor before the first
    // update. The recognizer already verified the block is date-shiftable.
    if (begin) startTouchScrub({block, blockId: block.id, startX: begin.startX, startY: begin.startY})
    updateTouchScrub(deltaDays, cancelIntent)
  },
}

/** `date-scrub-commit` COMMIT: write the previewed date. */
export const dateScrubCommitAction: ActionConfig<typeof ActionContextTypes.BLOCK_POINTER> = {
  id: 'daily-notes.date-scrub.commit',
  description: 'Two-finger date scrub: commit the new date',
  context: ActionContextTypes.BLOCK_POINTER,
  gestureBinding: {gesture: DATE_SCRUB_COMMIT_GESTURE},
  handler: () => {
    endTouchScrub(true)
  },
}

export const dateScrubGestureActions: readonly ActionConfig[] = [
  dateScrubRevealAction,
  dateScrubCommitAction,
]
