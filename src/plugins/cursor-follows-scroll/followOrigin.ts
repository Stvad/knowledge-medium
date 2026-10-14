import {
  peekFocusedBlockLocation,
  sameFocusedBlockLocation,
  type FocusedBlockLocation,
} from '@/data/properties.js'
import { EXTEND_BLOCK_SELECTION_ACTION_ID } from '@/extensions/blockSelectionAction.js'
import type { ActionDispatchDecorator } from '@/shortcuts/actionDispatch.js'
import { ActionContextTypes, type BlockPointerDependencies } from '@/shortcuts/types.js'

/**
 * Where the user left each panel's cursor before following a scroll moved it.
 *
 * A follow moves the cursor only so the next motion starts from what is on
 * screen; it is not the user choosing a row. A shift-click is the gesture that
 * cares about the difference: with no selection active it extends from the
 * cursor, and the cursor a follow left on the top visible row turns "from the
 * row I clicked, through everything I scrolled past" into "the rows on screen".
 *
 * Valid only while the cursor still sits where the follow put it — any other
 * move means the user placed it, and the range starts there again.
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
 *  on every cursor change: checking only at read time would take a cursor the
 *  user moved away and back onto the followed row for the follow's own. */
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

const followOriginFor = (
  panelId: string,
  cursor: FocusedBlockLocation | undefined,
): FocusedBlockLocation | undefined => {
  const follow = followsByPanel.get(panelId)
  return follow && sameFocusedBlockLocation(follow.followedTo, cursor) ? follow.origin : undefined
}

/**
 * Hands shift-click the row the user left as its `rangeOrigin` while the cursor
 * sits where a follow put it. Contributed outside spatial navigation's own
 * shift-click decorator (see the precedence at registration), which reads the
 * origin and would otherwise never see it.
 */
export const rangeOriginDecorator: ActionDispatchDecorator = {
  actionId: EXTEND_BLOCK_SELECTION_ACTION_ID,
  context: ActionContextTypes.BLOCK_POINTER,
  wrap: async (deps, trigger, next, dispatch) => {
    const pointerDeps = deps as BlockPointerDependencies
    const {uiStateBlock} = pointerDeps
    const rangeOrigin = followOriginFor(uiStateBlock.id, peekFocusedBlockLocation(uiStateBlock))
    await next(rangeOrigin ? {...pointerDeps, rangeOrigin} : deps, trigger, dispatch)
  },
}
