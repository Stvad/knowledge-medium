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

/** Reported back to the opener once the picker session ends, so callers
 *  that need to react to the outcome (e.g. the SRS review session, which
 *  only advances to the next card when a date was actually committed) can
 *  tell a real reschedule apart from a cancel / outside-tap / Escape. */
export interface ReschedulePickerResult {
  /** `true` only when the user committed a date and the write landed;
   *  `false` for cancel, Escape, outside-tap, or a refused write. */
  rescheduled: boolean
}

export interface OpenReschedulePickerEventDetail {
  blockId: string
  /** Workspace the block lives in. The picker uses this to call
   *  `getOrCreateDailyNote` — we pass it explicitly rather than reading
   *  from app state so a panel showing a different workspace can still
   *  reschedule its own block. */
  workspaceId: string
  anchorRect?: ReschedulePickerAnchorRect
  /** Invoked exactly once when the picker closes. Passed through the
   *  in-process CustomEvent detail (same-tab dispatch, so a function is
   *  safe). */
  onComplete?: (result: ReschedulePickerResult) => void
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
