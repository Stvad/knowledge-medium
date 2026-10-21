import {
  peekFocusedBlockLocation,
  sameFocusedBlockLocation,
  type FocusedBlockLocation,
} from '@/data/properties.js'
import { EXTEND_BLOCK_SELECTION_ACTION_ID } from '@/extensions/blockSelectionAction.js'
import type { VerbDecorator } from '@/facets/verbFacet.js'
import type { ActionInvocation } from '@/shortcuts/actionDispatch.js'
import { matchesAction } from '@/shortcuts/effectiveActions.js'
import {
  ActionContextTypes,
  type ActionHandlerResult,
  type BlockPointerDependencies,
} from '@/shortcuts/types.js'

/**
 * Where the user left each panel's cursor before following a scroll moved it.
 *
 * A follow moves the cursor only so the next motion starts from what is on
 * screen; it is not the user choosing a row. A shift-click is the gesture that
 * cares about the difference: with no selection active it extends from the
 * cursor, and the cursor a follow left on the top visible row turns "from the
 * row I clicked, through everything I scrolled past" into "the rows on screen".
 *
 * Valid until the user does anything in the panel, or the cursor moves: either
 * means the user placed it, and the range starts there again.
 *
 * Session memory, never persisted: after a reload the restored cursor is the
 * only cursor there is.
 */
interface Follow {
  origin: FocusedBlockLocation
  followedTo: FocusedBlockLocation
}

const followsByPanel = new Map<string, Follow>()

/** Record a follow from `from` to `to`. A follow from a row an earlier follow
 *  put the cursor on keeps that earlier origin — scrolling in several flicks
 *  is still one move away from where the user was. */
export const rememberFollow = (
  panelId: string,
  from: FocusedBlockLocation,
  to: FocusedBlockLocation,
): void => {
  const prior = followsByPanel.get(panelId)
  const origin = prior && sameFocusedBlockLocation(prior.followedTo, from) ? prior.origin : from
  followsByPanel.set(panelId, {origin, followedTo: to})
}

/** Forget the panel's follow unless the cursor is still where it put it. Run
 *  on every cursor change, for the moves no action dispatch announces
 *  (navigating, focus recovery): checking only when the follow is taken would
 *  read a cursor that went away and came back as never having moved. */
export const keepFollowOnlyAt = (
  panelId: string,
  cursor: FocusedBlockLocation | undefined,
): void => {
  const follow = followsByPanel.get(panelId)
  if (follow && !sameFocusedBlockLocation(follow.followedTo, cursor)) followsByPanel.delete(panelId)
}

export const forgetFollow = (panelId: string): void => {
  followsByPanel.delete(panelId)
}

/** Take the panel's follow: it is spent either way, and its origin is returned
 *  only if the cursor is still where the follow put it. The cursor check
 *  covers a move the follower has not re-rendered for yet. */
const takeFollowOrigin = (
  panelId: string,
  cursor: FocusedBlockLocation | undefined,
): FocusedBlockLocation | undefined => {
  const follow = followsByPanel.get(panelId)
  followsByPanel.delete(panelId)
  return follow && sameFocusedBlockLocation(follow.followedTo, cursor) ? follow.origin : undefined
}

const SHIFT_CLICK = {
  actionId: EXTEND_BLOCK_SELECTION_ACTION_ID,
  context: ActionContextTypes.BLOCK_POINTER,
}

/**
 * The next action dispatched in a panel consumes its follow: a shift-click
 * extends from the origin (handed over as `rangeOrigin`), and anything else —
 * a click, `i`, `j` — drops it, because acting on the cursor is placing it.
 * Watching the cursor cannot stand in for this: a click on the very row the
 * follow landed on writes the location already stored.
 *
 * Contributed above spatial navigation's shift-click decorator (see the
 * precedence at registration), which reads the origin. Passes `next`'s result
 * through untouched so a synchronous decline survives.
 */
export const consumeFollowOnDispatch: VerbDecorator<ActionInvocation, ActionHandlerResult> =
  next => invocation => {
    const {uiStateBlock} = invocation.deps
    if (!uiStateBlock) return next(invocation)
    const rangeOrigin = takeFollowOrigin(uiStateBlock.id, peekFocusedBlockLocation(uiStateBlock))
    // Only the shift-click's deps declare `rangeOrigin`; any other action just
    // spends the follow. Type scoping — nothing else would read the field.
    if (!rangeOrigin || !matchesAction(SHIFT_CLICK, invocation.action)) return next(invocation)
    const deps: BlockPointerDependencies = {...invocation.deps as BlockPointerDependencies, rangeOrigin}
    return next({...invocation, deps})
  }
