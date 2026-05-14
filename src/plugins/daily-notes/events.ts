export interface DailyNotePickerAnchorRect {
  bottom: number
  height: number
  left: number
  right: number
  top: number
  width: number
}

export interface OpenDailyNotePickerEventDetail {
  anchorRect?: DailyNotePickerAnchorRect
  initialIso?: string
}

export const openDailyNotePickerEvent = 'daily-notes.open-date-picker'

export const openDailyNotePicker = (
  detail: OpenDailyNotePickerEventDetail = {},
): void => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<OpenDailyNotePickerEventDetail>(
    openDailyNotePickerEvent,
    {detail},
  ))
}
