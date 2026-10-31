/**
 * Quoting part of a block. A range reference is no new syntax: it is an
 * ordinary `((T))` to a thread root T anchored to that range, and T renders
 * as the quote wherever it is referenced (`quotedRange.tsx`).
 */

import {TextQuote} from 'lucide-react'
import type {Repo} from '@/data/repo'
import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.js'
import {writeTextToClipboard} from '@/utils/copy.js'
import {showError, showInfo} from '@/utils/toast.js'
import {resolveAnchor, type AnchorResolution, type RangeAnchor} from './anchor.ts'
import {anchorOf, rangeFromEditor} from './actions.ts'
import {THREADS_FOR_BLOCK_QUERY, type ThreadSummary} from './summaries.ts'
import {createThread, isThreadRefusal, missingTarget} from './threads.ts'

export const COPY_RANGE_REFERENCE_ACTION_ID = 'annotations.copyReferenceToSelection'

const sameRange = (a: AnchorResolution, b: AnchorResolution): boolean =>
  a.state !== 'stale' && b.state !== 'stale' && a.from === b.from && a.to === b.to

/** Does `thread` highlight the text `selected` covers? Open, and its anchor
 *  resolves onto exactly that range, exact or moved: a thread whose text only
 *  shifted, or whose context was edited, still marks the same characters. */
const highlights = (thread: ThreadSummary, content: string, selected: AnchorResolution): boolean =>
  thread.open && thread.anchor.kind === 'range' && sameRange(resolveAnchor(content, thread.anchor), selected)

/** The thread a reference to `anchor` should point at: the target's open
 *  thread that highlights the same text of `content`, the text the anchor was
 *  captured from, so quoting a range twice gives one thread; or else a new
 *  highlight.
 *
 *  ACCEPTED: the lookup runs before the creating tx, so two copies of the same
 *  range racing each other can leave a second, unreferenced highlight. */
export const threadForRange = async (
  repo: Repo,
  targetId: string,
  anchor: RangeAnchor,
  content: string,
): Promise<string> => {
  const target = await repo.load(targetId)
  if (!target) throw missingTarget(targetId)
  const threads = await repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId: target.workspaceId, id: targetId}).load()
  const selected = resolveAnchor(content, anchor)
  const existing = threads.find(thread => highlights(thread, content, selected))
  if (existing) return existing.id
  const created = await createThread(repo, {targetId, anchor}, {description: 'copy reference to selection'})
  return created.threadId
}

/** Unlike commenting, this opens no composer, so it works wherever the block
 *  is edited: an embed, a backlink entry, a comment in a card. */
export const copyRangeReferenceAction: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
  id: COPY_RANGE_REFERENCE_ACTION_ID,
  description: 'Copy reference to selection',
  context: ActionContextTypes.EDIT_MODE_CM,
  icon: TextQuote,
  handler: async ({block, editorView}) => {
    const range = rangeFromEditor(editorView)
    const anchor = anchorOf(range)
    if (!anchor) {
      showInfo('Select the text to quote.')
      return
    }
    let threadId: string
    try {
      threadId = await threadForRange(block.repo, block.id, anchor, range.content)
    } catch (error) {
      if (isThreadRefusal(error)) showError(error.message)
      else throw error
      return
    }
    try {
      await writeTextToClipboard(`((${threadId}))`)
    } catch {
      // The highlight stays, and the next copy of this range reuses it.
      showError('The browser refused to write to the clipboard. Try again.')
      return
    }
    showInfo('Copied a reference to the selection.')
  },
}
