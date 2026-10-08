/** Replacing a piece of a block's text once async work settles (a place
 *  resolution, a collision toast). By then the text may have moved or be
 *  gone, and an editor may have unmounted or mounted — so the target is
 *  re-located with the caller's `Locate` (which knows what the target IS,
 *  not just its text), in the block's text wherever it lives at THAT
 *  moment: its live editor if one is mounted, else the stored content. */

import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import { flushEditorContent } from '@/editor/contentFlush'
import { liveEditorFor } from '@/editor/liveEditors'

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

/** The text a replacement would act on now; `null` when the block is gone. */
export const readBlockText = async (repo: Repo, blockId: string): Promise<string | null> => {
  const editor = liveEditorFor(blockId)
  if (editor) return editor.state.doc.toString()
  const data = await repo.load(blockId)
  return data && !data.deleted ? data.content : null
}

const replaceInEditor = (view: EditorView, locate: Locate, replacement: string): boolean => {
  const at = locate(view.state.doc.toString())
  if (at === null) return false
  view.dispatch({
    changes: {from: at.from, to: at.to, insert: replacement},
    selection: EditorSelection.cursor(at.from + replacement.length),
  })
  // Commit now rather than on the editor's debounce, so follow-up work
  // reads it from the stored row.
  flushEditorContent(view)
  return true
}

/** Read-modify-write inside a tx, so a concurrent editor flush can't be
 *  clobbered. */
const replaceInStoredContent = async (
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

/** False when the target is gone. While an editor is mounted only ITS
 *  text counts — the stored row trails it and may still hold the target. */
export const replaceBlockText = async (args: {
  repo: Repo
  blockId: string
  locate: Locate
  replacement: string
  description: string
}): Promise<boolean> => {
  const editor = liveEditorFor(args.blockId)
  return editor
    ? replaceInEditor(editor, args.locate, args.replacement)
    : replaceInStoredContent(args.repo, args.blockId, args.locate, args.replacement, args.description)
}
