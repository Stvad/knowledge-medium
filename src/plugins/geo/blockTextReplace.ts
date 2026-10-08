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

/** While the editor is mounted it is the authority: `absent` means the
 *  target is gone, full stop — the stored row trails the editor and may
 *  still hold it. Only `unmounted` sends the caller to the stored row. */
export type ViewReplacement = 'replaced' | 'absent' | 'unmounted'

export const replaceInView = (view: EditorView, locate: Locate, replacement: string): ViewReplacement => {
  if (!isMounted(view)) return 'unmounted'
  const at = locate(view.state.doc.toString())
  if (at === null) return 'absent'
  try {
    view.dispatch({
      changes: {from: at.from, to: at.to, insert: replacement},
      selection: EditorSelection.cursor(at.from + replacement.length),
    })
    return 'replaced'
  } catch {
    // Torn down between the mount check and the dispatch.
    return 'unmounted'
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

/** The live editor while `view` is mounted, else the stored content. */
export const replaceBlockText = async (args: {
  repo: Repo
  blockId: string
  view?: EditorView
  locate: Locate
  replacement: string
  description: string
}): Promise<boolean> => {
  const {view, locate, replacement} = args
  const outcome = view ? replaceInView(view, locate, replacement) : 'unmounted'
  if (outcome === 'unmounted') {
    return replaceInStoredContent(args.repo, args.blockId, locate, replacement, args.description)
  }
  // Commit the edit now rather than on the editor's debounce, so
  // follow-up work reads it from the stored row.
  if (outcome === 'replaced' && view) flushEditorContent(view)
  return outcome === 'replaced'
}
