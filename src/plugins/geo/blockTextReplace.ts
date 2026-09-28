/** Replacing a piece of a block's text once async work settles (a place
 *  resolution, a collision toast). By then the text may have moved or be
 *  gone, and the block's editor may have unmounted — so the replacement
 *  re-locates the text, and lands in the live editor when there is one
 *  (its pending debounced write would otherwise clobber a stored-content
 *  edit) or in the stored content when there isn't. */

import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import { flushEditorContent } from '@/editor/contentFlush'

export interface TextSpan {
  from: number
  to: number
}

/** Where `text` is now: the recorded span if it still holds it, else its
 *  first occurrence (other edits moved it); `null` when it's gone. */
export const locateText = (doc: string, span: TextSpan, text: string): TextSpan | null => {
  if (text.length === 0) return null
  if (doc.slice(span.from, span.to) === text) return span
  const idx = doc.indexOf(text)
  if (idx === -1) return null
  return {from: idx, to: idx + text.length}
}

/** False when the view is unmounted or no longer holds `text` — the
 *  caller falls back to `replaceInStoredContent`. */
export const replaceInView = (
  view: EditorView,
  span: TextSpan,
  text: string,
  replacement: string,
): boolean => {
  // `EditorView.destroyed` is private API; a detached root is the
  // observable signature of an unmounted per-block editor.
  if (!view.dom.isConnected) return false
  const at = locateText(view.state.doc.toString(), span, text)
  if (at === null) return false
  try {
    view.dispatch({
      changes: {from: at.from, to: at.to, insert: replacement},
      selection: EditorSelection.cursor(at.from + replacement.length),
    })
    return true
  } catch {
    return false
  }
}

/** Read-modify-write inside a tx, so a concurrent editor flush can't be
 *  clobbered. False when the block or the text is gone. */
export const replaceInStoredContent = async (
  repo: Repo,
  blockId: string,
  text: string,
  replacement: string,
  description: string,
): Promise<boolean> => {
  let replaced = false
  await repo.tx(async tx => {
    const data = await tx.get(blockId)
    if (!data || data.deleted) return
    const at = locateText(data.content, {from: 0, to: 0}, text)
    if (at === null) return
    await tx.update(blockId, {
      content: data.content.slice(0, at.from) + replacement + data.content.slice(at.to),
    })
    replaced = true
  }, {scope: ChangeScope.BlockDefault, description})
  return replaced
}

/** The live editor when `view` is given and still holds the text, else
 *  the stored content. */
export const replaceBlockText = async (args: {
  repo: Repo
  blockId: string
  view?: EditorView
  span: TextSpan
  text: string
  replacement: string
  description: string
}): Promise<boolean> => {
  const {view, span, text, replacement} = args
  if (view && replaceInView(view, span, text, replacement)) {
    // Commit the edit now rather than on the editor's debounce, so
    // follow-up work reads it from the stored row.
    flushEditorContent(view)
    return true
  }
  return replaceInStoredContent(args.repo, args.blockId, text, replacement, args.description)
}
