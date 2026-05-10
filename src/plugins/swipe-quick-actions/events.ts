export interface SwipeQuickActionMenuEventDetail {
  blockId: string
}

export type SwipeQuickActionMenuEvent = CustomEvent<SwipeQuickActionMenuEventDetail>

export const SWIPE_QUICK_ACTION_OPEN_EVENT = 'swipe-quick-actions:open'
export const SWIPE_QUICK_ACTION_CLOSE_EVENT = 'swipe-quick-actions:close'

export const isSwipeQuickActionMenuEvent = (
  event: Event,
): event is SwipeQuickActionMenuEvent =>
  event instanceof CustomEvent &&
  typeof event.detail === 'object' &&
  event.detail !== null &&
  typeof (event.detail as {blockId?: unknown}).blockId === 'string'

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
