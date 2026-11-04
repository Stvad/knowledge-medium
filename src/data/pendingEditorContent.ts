/** Saving what open block editors hold before focus leaves them.
 *
 *  `BlockEditor` debounces its content write, so the stored row lags the view.
 *  A writer of focus or the edit flag calls `flushPendingEditorContent()`
 *  synchronously, immediately before its own `repo.tx`. The content write then
 *  takes the FIFO write lock first, and the upload queue keeps that order, so
 *  whoever reads "not being edited" also finds the text.
 *
 *  The order rests on `Block.setContent` and `repo.tx` reaching the lock in call
 *  order: an `await` ahead of the lock on only one of those paths breaks it.
 *
 *  Writers don't ask whether they really leave an editor, and it flushes every
 *  mounted one: an early save costs what a pause in typing costs, one undo
 *  boundary. A writer that skips this still saves, through the editor's unmount
 *  flush, just after its focus write.
 *
 *  `flushEditorContent` (`@/editor/contentFlush`) is the per-view flush for
 *  commit points inside an editor, which keep focus where it is. */

import { CallbackSet } from '@/utils/callbackSet'

const contentFlushes = new CallbackSet<[]>('pending-editor-content')

/** Register an editor's content flush for as long as it is mounted. */
export const registerPendingContentFlush = (flush: () => void): (() => void) =>
  contentFlushes.add(flush)

export const flushPendingEditorContent = (): void => contentFlushes.notify()
