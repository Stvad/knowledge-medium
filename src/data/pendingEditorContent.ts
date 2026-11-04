/** Saving what open block editors hold before focus leaves them.
 *
 *  `BlockEditor` debounces its content write, so the stored row lags the view.
 *  A writer that moves focus or clears the edit flag calls
 *  `flushPendingEditorContent()` synchronously, immediately before its own
 *  `repo.tx`. The content write then takes the FIFO write lock first, so it
 *  commits and uploads ahead of the focus write, and whoever reads "not being
 *  edited", on this device or another, also finds the text.
 *
 *  It flushes every mounted editor: another panel's text saved a little early
 *  costs nothing. A writer that misses this still saves, through the editor's
 *  unmount flush, just after its focus write.
 *
 *  `flushEditorContent` (`@/editor/contentFlush`) is the per-view flush for
 *  commit points inside an editor, which keep focus where it is. */

import { CallbackSet } from '@/utils/callbackSet'

const contentFlushes = new CallbackSet<[]>('pending-editor-content')

/** Register an editor's content flush for as long as it is mounted. */
export const registerPendingContentFlush = (flush: () => void): (() => void) =>
  contentFlushes.add(flush)

export const flushPendingEditorContent = (): void => contentFlushes.notify()
