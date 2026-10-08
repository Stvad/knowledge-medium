/** Replacing a piece of a block's text once async work settles (a place
 *  resolution, a collision toast). By then the text may have moved or be
 *  gone, and the block's editor may have unmounted — so the replacement
 *  re-locates its target with the caller's `Locate` (which knows what the
 *  target IS, not just its text), and lands in the live editor when there is one
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

/** Finds the replacement's target in the current text; `null` when it's
 *  gone. */
export type Locate = (doc: string) => TextSpan | null

/** Where `text` is now: `near` if it still holds it, else its first
 *  occurrence (other edits moved it); `null` when it's gone. */
export const locateText = (doc: string, text: string, near?: TextSpan): TextSpan | null => {
  if (text.length === 0) return null
  if (near && doc.slice(near.from, near.to) === text) return near
  const idx = doc.indexOf(text)
  if (idx === -1) return null
  return {from: idx, to: idx + text.length}
}

const isMounted = (view: EditorView | undefined): view is EditorView =>
  // `EditorView.destroyed` is private API; a detached root is the
  // observable signature of an unmounted per-block editor.
  view !== undefined && view.dom.isConnected

/** The text the replacement would act on: the live editor's while it's
 *  mounted, else the stored content; `null` when the block is gone. */
export const readBlockText = async (
  repo: Repo,
  blockId: string,
  view?: EditorView,
): Promise<string | null> => {
  if (isMounted(view)) return view.state.doc.toString()
  const data = await repo.load(blockId)
  return data && !data.deleted ? data.content : null
}

/** False when the view is unmounted or no longer holds the target — the
 *  caller falls back to `replaceInStoredContent`. */
export const replaceInView = (view: EditorView, locate: Locate, replacement: string): boolean => {
  if (!isMounted(view)) return false
  const at = locate(view.state.doc.toString())
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
 *  clobbered. False when the block or the target is gone. */
export const replaceInStoredContent = async (
  repo: Repo,
  blockId: string,
  locate: Locate,
  replacement: string,
  description: string,
): Promise<boolean> => {
  let replaced = false
  await repo.tx(async tx => {
    const data = await tx.get(blockId)
    if (!data || data.deleted) return
    const at = locate(data.content)
    if (at === null) return
    await tx.update(blockId, {
      content: data.content.slice(0, at.from) + replacement + data.content.slice(at.to),
    })
    replaced = true
  }, {scope: ChangeScope.BlockDefault, description})
  return replaced
}

/** The live editor when `view` is given and still holds the target, else
 *  the stored content. */
export const replaceBlockText = async (args: {
  repo: Repo
  blockId: string
  view?: EditorView
  locate: Locate
  replacement: string
  description: string
}): Promise<boolean> => {
  const {view, locate, replacement} = args
  if (view && replaceInView(view, locate, replacement)) {
    // Commit the edit now rather than on the editor's debounce, so
    // follow-up work reads it from the stored row.
    flushEditorContent(view)
    return true
  }
  return replaceInStoredContent(args.repo, args.blockId, locate, replacement, args.description)
}
