/**
 * A held block: one finger resting on a block's content for the shared
 * touch hold (`TOUCH_HOLD_MS` within `TOUCH_SLOP_PX`) commits `block-hold`,
 * which the touch-selection actions bind to select the block. The commit
 * spends the press (see `createBlockGestureController`), so lifting the
 * finger afterwards neither swipes nor clicks the block open.
 *
 * Moving past the slop first gives up: that touch is a scroll, or a swipe
 * the swipe recognizer claims at its own lock distance, which evicts this
 * one. A second finger gives up too, leaving the touch to the date scrub.
 * The bullet is outside the content surface, so its hold (block drag) never
 * reaches here.
 */
import {
  GESTURE_CANCEL,
  GESTURE_IDLE,
  TOUCH_HOLD_MS,
  TOUCH_SLOP_PX,
  type BlockGestureRecognizerContribution,
  type GestureRecognizer,
} from '@/extensions/continuousGestures.js'
import { isGestureSurfaceTarget } from '@/extensions/blockInteraction.js'
import { isEditingBlock } from '@/data/properties.js'
import type { BlockPointerDependencies } from '@/shortcuts/types.js'
import { isPointerCoarse } from '@/utils/viewport.js'

export const BLOCK_HOLD_GESTURE = 'block-hold'
export const BLOCK_HOLD_RECOGNIZER_ID = 'touch-selection.hold'

interface Press {
  readonly pointerId: number
  readonly x: number
  readonly y: number
}

export const blockHoldRecognizer: BlockGestureRecognizerContribution = context => {
  const {block, uiStateBlock} = context
  const renderScopeId = typeof context.blockContext?.renderScopeId === 'string'
    ? context.blockContext.renderScopeId
    : undefined
  let press: Press | null = null

  const recognizer: GestureRecognizer = {
    id: BLOCK_HOLD_RECOGNIZER_ID,
    holdMs: TOUCH_HOLD_MS,
    // Where the hold is ours rather than the browser's text selection: a
    // touch-primary device (the read-mode content styles in
    // TouchSelectionLayer apply on the same query), a block that isn't being
    // edited, and a writable workspace, whose text has an editor to select
    // it in. A read-only one keeps native selection as its only way to copy.
    isEnabled: () =>
      isPointerCoarse() &&
      !uiStateBlock.repo.isReadOnly &&
      !isEditingBlock(uiStateBlock, block.id, renderScopeId),

    onPointerDown(session, ctx) {
      if (session.pointers.length > 1) {
        press = null
        return GESTURE_CANCEL
      }
      if (ctx.event.pointerType !== 'touch' || !isGestureSurfaceTarget(ctx.event.target)) {
        return GESTURE_IDLE
      }
      press = {pointerId: session.changed.pointerId, x: session.changed.x, y: session.changed.y}
      return GESTURE_IDLE
    },

    onPointerMove(session) {
      if (!press || session.changed.pointerId !== press.pointerId) return GESTURE_IDLE
      const travel = Math.hypot(session.changed.x - press.x, session.changed.y - press.y)
      if (travel <= TOUCH_SLOP_PX) return GESTURE_IDLE
      press = null
      return GESTURE_CANCEL
    },

    onHold(_session, ctx) {
      if (!press) return GESTURE_IDLE
      press = null
      const deps: BlockPointerDependencies = {
        block,
        uiStateBlock,
        scopeRootId: context.scopeRootId,
        scopeRootForcesOpen: !context.blockContext?.isNestedSurface,
        targetElement: ctx.element,
        ...(renderScopeId ? {renderScopeId} : {}),
      }
      return {status: 'commit', gesture: BLOCK_HOLD_GESTURE, deps}
    },

    onPointerUp() {
      press = null
      return GESTURE_IDLE
    },

    onPointerCancel() {
      press = null
    },
  }

  return recognizer
}
