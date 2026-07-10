/** Per-view hook for synchronously persisting the editor's pending
 *  (debounced) content write.
 *
 *  `BlockEditor` persists content via a 300ms-debounced `setContent`, so
 *  the stored block row lags the live CodeMirror view between keystrokes.
 *  That's fine for ordinary typing, but a completion acceptance is a
 *  commit point: the `apply` mutates the doc and then does async work
 *  (resolve a place, tag a block) — and a type-add even REMOUNTS the
 *  editor, reseeding the fresh view from the cached row. If that work
 *  reads (or the remount reseeds from) a stored row still holding the
 *  pre-accept content, the user's edit silently reverts or a stale value
 *  is baked in.
 *
 *  So at accept time the completion calls `flushEditorContent(view)`,
 *  which fires the debounced write NOW — the flush lands on the FIFO
 *  write lock ahead of the apply's own tx, so downstream reads see a
 *  stored row consistent with the view. `BlockEditor` publishes its
 *  flush through `editorContentFlushFacet`; views with no React-side
 *  persistence (bare test harnesses) publish nothing and the helper is a
 *  no-op. */

import { Facet } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/** Single flush callback per view (BlockEditor's `flushDebouncers`).
 *  `combine` takes the first provider — there is only ever one. */
export const editorContentFlushFacet = Facet.define<() => void, (() => void) | null>({
  combine: values => values[0] ?? null,
})

/** Persist the editor's pending content write so the stored row matches
 *  the live view. Call at completion-accept time, after the `apply` has
 *  dispatched its doc change (so the debounce has captured the new value)
 *  and before any async work / type-add remount that reads stored
 *  content. No-op when the view publishes no flush. */
export const flushEditorContent = (view: EditorView): void => {
  view.state.facet(editorContentFlushFacet)?.()
}
