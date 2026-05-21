/** Dialog-open events. Action handlers dispatch via the helpers
 *  below; the globally-mounted dialogs (ExtractTypeDialog,
 *  FindSimilarDialog) listen on window. Same pattern as
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

export interface OpenFindSimilarDialogEventDetail {
  prototypeBlockId: string
}

export const openFindSimilarDialogEvent = 'extract-type.open-find-similar-dialog'

export const openFindSimilarDialog = (
  detail: OpenFindSimilarDialogEventDetail,
): void => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<OpenFindSimilarDialogEventDetail>(
    openFindSimilarDialogEvent,
    {detail},
  ))
}
