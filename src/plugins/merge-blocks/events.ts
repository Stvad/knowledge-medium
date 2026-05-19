/**
 * Cross-component bridge that opens the merge-target picker. Mirrors the
 * reschedule/daily-note-picker open events so the action handler can fire
 * the modal without holding a ref to the React component.
 */
export interface OpenMergePickerEventDetail {
  /** The block whose content + properties get folded into the picked
   *  target. Source disappears (soft-deleted) at the end. */
  sourceBlockId: string
  /** Workspace the source lives in. Passed explicitly so a panel
   *  showing a different workspace can still trigger its own merge
   *  (same rationale as `OpenReschedulePickerEventDetail.workspaceId`). */
  workspaceId: string
}

export const openMergePickerEvent = 'merge-blocks.open-picker'

export const openMergePicker = (detail: OpenMergePickerEventDetail): void => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<OpenMergePickerEventDetail>(
    openMergePickerEvent,
    {detail},
  ))
}
