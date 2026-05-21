/** Open the extract-type dialog scoped to a specific prototype block.
 *  The action handler dispatches; the globally-mounted dialog listens.
 *  Same pattern as `openDailyNotePicker`. */

export interface OpenExtractTypeDialogEventDetail {
  prototypeBlockId: string
}

export const openExtractTypeDialogEvent = 'extract-type.open-dialog'

export const openExtractTypeDialog = (
  detail: OpenExtractTypeDialogEventDetail,
): void => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<OpenExtractTypeDialogEventDetail>(
    openExtractTypeDialogEvent,
    {detail},
  ))
}
