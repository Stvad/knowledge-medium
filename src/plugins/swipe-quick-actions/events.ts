export interface SwipeQuickActionMenuEventDetail {
  blockId: string
}

export interface SwipeQuickActionRunEventDetail extends SwipeQuickActionMenuEventDetail {
  actionId: string
}

export type SwipeQuickActionMenuEvent = CustomEvent<SwipeQuickActionMenuEventDetail>
export type SwipeQuickActionRunEvent = CustomEvent<SwipeQuickActionRunEventDetail>

export const SWIPE_QUICK_ACTION_OPEN_EVENT = 'swipe-quick-actions:open'
export const SWIPE_QUICK_ACTION_CLOSE_EVENT = 'swipe-quick-actions:close'
export const SWIPE_QUICK_ACTION_RUN_EVENT = 'swipe-quick-actions:run'

export const isSwipeQuickActionMenuEvent = (
  event: Event,
): event is SwipeQuickActionMenuEvent =>
  event instanceof CustomEvent &&
  typeof event.detail === 'object' &&
  event.detail !== null &&
  typeof (event.detail as {blockId?: unknown}).blockId === 'string'

export const isSwipeQuickActionRunEvent = (
  event: Event,
): event is SwipeQuickActionRunEvent =>
  isSwipeQuickActionMenuEvent(event) &&
  typeof (event.detail as {actionId?: unknown}).actionId === 'string'

export const dispatchSwipeQuickActionMenuEvent = (
  target: EventTarget,
  type: typeof SWIPE_QUICK_ACTION_OPEN_EVENT | typeof SWIPE_QUICK_ACTION_CLOSE_EVENT,
  blockId: string,
): boolean =>
  target.dispatchEvent(new CustomEvent<SwipeQuickActionMenuEventDetail>(type, {
    bubbles: true,
    cancelable: true,
    detail: {blockId},
  }))

export const dispatchSwipeQuickActionRunEvent = (
  target: EventTarget,
  actionId: string,
  blockId: string,
): boolean =>
  target.dispatchEvent(new CustomEvent<SwipeQuickActionRunEventDetail>(SWIPE_QUICK_ACTION_RUN_EVENT, {
    bubbles: true,
    cancelable: true,
    detail: {blockId, actionId},
  }))
