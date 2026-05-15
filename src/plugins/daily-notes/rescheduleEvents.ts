/**
 * Cross-component bridge that opens the mobile reschedule sheet.
 * Mirrors the daily-note-picker open event so consumers don't need a
 * direct ref to the React component.
 */
export interface ReschedulePickerAnchorRect {
  bottom: number
  height: number
  left: number
  right: number
  top: number
  width: number
}

export interface OpenReschedulePickerEventDetail {
  blockId: string
  /** Workspace the block lives in. The picker uses this to call
   *  `getOrCreateDailyNote` — we pass it explicitly rather than reading
   *  from app state so a panel showing a different workspace can still
   *  reschedule its own block. */
  workspaceId: string
  anchorRect?: ReschedulePickerAnchorRect
}

export const openReschedulePickerEvent = 'daily-notes.open-reschedule-picker'

export const openReschedulePicker = (
  detail: OpenReschedulePickerEventDetail,
): void => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<OpenReschedulePickerEventDetail>(
    openReschedulePickerEvent,
    {detail},
  ))
}
