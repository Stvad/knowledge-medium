/** Replacing a piece of a block's text once async work settles (a place
 *  resolution, a collision toast). By then the text may have moved or be
 *  gone, and an editor may have unmounted or mounted — so the target is
 *  re-located with the caller's `Locate` (which knows what the target IS,
 *  not just its text), in the block's text wherever it lives at THAT
 *  moment: its live editor if one is mounted, else the stored content.
 *
 *  Every write runs its guards (editor ownership, read-only) synchronously
 *  right before writing — never across an await, where an editor can open
 *  or the workspace's role can change. */

import { ChangeScope, type BlockData } from '@/data/api'
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

/** The block now, with the text a replacement would act on; `null` when
 *  the block is gone. */
export const readBlock = async (
  repo: Repo,
  blockId: string,
): Promise<{data: BlockData; text: string} | null> => {
  const data = await repo.load(blockId)
  if (!data || data.deleted) return null
  // After the load, not before: an editor that mounted during it leads the row.
  return {data, text: liveEditorFor(blockId)?.state.doc.toString() ?? data.content}
}

/** `null` when no editor owns the block's text right now. */
const replaceInLiveEditor = (
  repo: Repo,
  blockId: string,
  locate: Locate,
  replacement: string,
): boolean | null => {
  const view = liveEditorFor(blockId)
  if (!view) return null
  // The editor writes no tx until its flush, which a read-only repo rejects.
  if (repo.isReadOnly) return false
  const at = locate(view.state.doc.toString())
  if (at === null) return false
  // No explicit selection: the caret maps through the change, so it stays
  // where the user is — or lands after the replacement if it sat right
  // after the target, as on an accepted completion.
  view.dispatch({changes: {from: at.from, to: at.to, insert: replacement}})
  // Commit now rather than on the editor's debounce, so follow-up work
  // reads it from the stored row.
  flushEditorContent(view)
  return true
}

/** Read-modify-write inside a tx, so a concurrent editor flush can't be
 *  clobbered. `editor-mounted`: an editor opened before the write and now
 *  owns the text — nothing was written. An editor opening DURING the write
 *  itself is accepted, not chased further: it is the kernel's case for
 *  every outside writer (BlockEditor adopts the change unless the user
 *  already typed past it). */
const replaceInStoredContent = async (
  repo: Repo,
  blockId: string,
  locate: Locate,
  replacement: string,
  description: string,
): Promise<'replaced' | 'absent' | 'editor-mounted'> => {
  // Repo.tx refuses a read-only repo before running the callback; the
  // check inside covers a role change while the row is read.
  if (repo.isReadOnly) return 'absent'
  let outcome: 'replaced' | 'absent' | 'editor-mounted' = 'absent'
  await repo.tx(async tx => {
    const data = await tx.get(blockId)
    if (liveEditorFor(blockId)) {
      outcome = 'editor-mounted'
      return
    }
    if (repo.isReadOnly || !data || data.deleted) return
    const at = locate(data.content)
    if (at === null) return
    await tx.update(blockId, {
      content: data.content.slice(0, at.from) + replacement + data.content.slice(at.to),
    })
    outcome = 'replaced'
  }, {scope: ChangeScope.BlockDefault, description})
  return outcome
}

/** False when the target is gone or the workspace is read-only. While an
 *  editor is mounted only ITS text counts — the stored row trails it and
 *  may still hold the target. */
export const replaceBlockText = async (args: {
  repo: Repo
  blockId: string
  locate: Locate
  replacement: string
  description: string
}): Promise<boolean> => {
  const {repo, blockId, locate, replacement} = args
  const direct = replaceInLiveEditor(repo, blockId, locate, replacement)
  if (direct !== null) return direct
  const stored = await replaceInStoredContent(repo, blockId, locate, replacement, args.description)
  if (stored !== 'editor-mounted') return stored === 'replaced'
  return replaceInLiveEditor(repo, blockId, locate, replacement) ?? false
}
