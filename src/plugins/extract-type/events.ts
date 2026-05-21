/** Dialog-open events. Action handlers dispatch via the helpers
 *  below; the globally-mounted dialogs (ExtractTypeDialog,
 *  FindTypeInstancesDialog) listen on window. Same pattern as
 *  `openDailyNotePicker`. */

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

export interface OpenFindTypeInstancesDialogEventDetail {
  /** The block-type block whose property shape we'll search for. */
  typeBlockId: string
}

export const openFindTypeInstancesDialogEvent = 'extract-type.open-find-type-instances-dialog'

export const openFindTypeInstancesDialog = (
  detail: OpenFindTypeInstancesDialogEventDetail,
): void => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<OpenFindTypeInstancesDialogEventDetail>(
    openFindTypeInstancesDialogEvent,
    {detail},
  ))
}
