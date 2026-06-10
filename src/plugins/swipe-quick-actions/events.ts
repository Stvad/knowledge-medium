export interface SwipeQuickActionMenuEventDetail {
  blockId: string
  renderScopeId?: string
}

export interface SwipeQuickActionRunEventDetail extends SwipeQuickActionMenuEventDetail {
  actionId: string
}

/** Streamed during an in-flight horizontal swipe so SwipeActionMenu can
 *  render the toolbar tracking the finger. `dx` is the horizontal delta
 *  from the gesture's starting point — negative while dragging left to
 *  open. Phase `active` fires on every touchmove past the direction
 *  lock; `cancel` fires once on release when the swipe didn't commit,
 *  so the menu can animate back to hidden. Commits dispatch the OPEN
 *  event instead and the menu treats that as its settle target. */
export interface SwipeQuickActionProgressEventDetail extends SwipeQuickActionMenuEventDetail {
  dx: number
  phase: 'active' | 'cancel'
}

export type SwipeQuickActionMenuEvent = CustomEvent<SwipeQuickActionMenuEventDetail>
export type SwipeQuickActionRunEvent = CustomEvent<SwipeQuickActionRunEventDetail>
export type SwipeQuickActionProgressEvent = CustomEvent<SwipeQuickActionProgressEventDetail>

export const SWIPE_QUICK_ACTION_OPEN_EVENT = 'swipe-quick-actions:open'
export const SWIPE_QUICK_ACTION_CLOSE_EVENT = 'swipe-quick-actions:close'
export const SWIPE_QUICK_ACTION_RUN_EVENT = 'swipe-quick-actions:run'
export const SWIPE_QUICK_ACTION_PROGRESS_EVENT = 'swipe-quick-actions:progress'

/** The streamed progress TICK the recognizer hands to its `progress`-phase
 *  action as the trigger (in-memory, NOT dispatched to the DOM). The action
 *  reads `dx` and bridges to the menu via {@link dispatchSwipeQuickActionProgressEvent}.
 *  Separate from SWIPE_QUICK_ACTION_PROGRESS_EVENT, which is the action→menu
 *  DOM event. */
export const SWIPE_QUICK_ACTION_PROGRESS_TICK_EVENT = 'swipe-quick-actions:progress-tick'

export interface SwipeProgressTickDetail {
  dx: number
}

export const swipeProgressTickEvent = (dx: number): CustomEvent<SwipeProgressTickDetail> =>
  new CustomEvent<SwipeProgressTickDetail>(SWIPE_QUICK_ACTION_PROGRESS_TICK_EVENT, {detail: {dx}})

export const isSwipeQuickActionMenuEvent = (
  event: Event,
): event is SwipeQuickActionMenuEvent => {
  if (!(event instanceof CustomEvent) || typeof event.detail !== 'object' || event.detail === null) {
    return false
  }
  const detail = event.detail as {blockId?: unknown; renderScopeId?: unknown}
  return typeof detail.blockId === 'string' &&
    (detail.renderScopeId === undefined || typeof detail.renderScopeId === 'string')
}

export const isSwipeQuickActionRunEvent = (
  event: Event,
): event is SwipeQuickActionRunEvent =>
  isSwipeQuickActionMenuEvent(event) &&
  typeof (event.detail as {actionId?: unknown}).actionId === 'string'

export const isSwipeQuickActionProgressEvent = (
  event: Event,
): event is SwipeQuickActionProgressEvent =>
  isSwipeQuickActionMenuEvent(event) &&
  typeof (event.detail as {dx?: unknown}).dx === 'number' &&
  typeof (event.detail as {phase?: unknown}).phase === 'string'

export const dispatchSwipeQuickActionMenuEvent = (
  target: EventTarget,
  type: typeof SWIPE_QUICK_ACTION_OPEN_EVENT | typeof SWIPE_QUICK_ACTION_CLOSE_EVENT,
  blockId: string,
  renderScopeId?: string,
): boolean =>
  target.dispatchEvent(new CustomEvent<SwipeQuickActionMenuEventDetail>(type, {
    bubbles: true,
    cancelable: true,
    detail: renderScopeId ? {blockId, renderScopeId} : {blockId},
  }))

export const dispatchSwipeQuickActionRunEvent = (
  target: EventTarget,
  actionId: string,
  blockId: string,
  renderScopeId?: string,
): boolean =>
  target.dispatchEvent(new CustomEvent<SwipeQuickActionRunEventDetail>(SWIPE_QUICK_ACTION_RUN_EVENT, {
    bubbles: true,
    cancelable: true,
    detail: renderScopeId ? {blockId, renderScopeId, actionId} : {blockId, actionId},
  }))

export const dispatchSwipeQuickActionProgressEvent = (
  target: EventTarget,
  blockId: string,
  dx: number,
  phase: 'active' | 'cancel',
  renderScopeId?: string,
): boolean =>
  target.dispatchEvent(new CustomEvent<SwipeQuickActionProgressEventDetail>(SWIPE_QUICK_ACTION_PROGRESS_EVENT, {
    bubbles: true,
    cancelable: true,
    detail: renderScopeId ? {blockId, renderScopeId, dx, phase} : {blockId, dx, phase},
  }))
