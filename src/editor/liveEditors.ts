/** The block editors mounted right now, by block id.
 *
 *  For async work that edits a block's text after a wait (a place
 *  resolution, a link conversion): by then the editor it started in may
 *  have unmounted, or the user may have opened one. While an editor is
 *  mounted it is the authority — a stored-content write loses to its
 *  uncommitted typing — so such work looks the editor up when it WRITES,
 *  never capturing one when it starts. */

import { ViewPlugin, type EditorView } from '@codemirror/view'

const liveEditors = new Map<string, EditorView[]>()

/** Registers the view for `blockId` for exactly as long as it exists. */
export const liveEditorRegistration = (blockId: string) =>
  ViewPlugin.define(view => {
    liveEditors.set(blockId, [...(liveEditors.get(blockId) ?? []), view])
    return {
      destroy: () => {
        const rest = (liveEditors.get(blockId) ?? []).filter(v => v !== view)
        if (rest.length > 0) liveEditors.set(blockId, rest)
        else liveEditors.delete(blockId)
      },
    }
  })

/** The block's editor the user is in, else its most recently mounted one
 *  (a block can be open for editing in two panels at once). */
export const liveEditorFor = (blockId: string): EditorView | undefined => {
  const views = liveEditors.get(blockId)
  return views?.find(view => view.hasFocus) ?? views?.at(-1)
}
