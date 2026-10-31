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
import type {RangeAnchor} from './anchor.ts'
import {anchorOf, rangeFromEditor} from './actions.ts'
import {highlightRange} from './highlights.ts'
import {THREADS_FOR_BLOCK_QUERY} from './summaries.ts'
import {createThread, isThreadRefusal, missingTarget} from './threads.ts'

export const COPY_RANGE_REFERENCE_ACTION_ID = 'annotations.copyReferenceToSelection'

/** The thread a reference to `anchor` should point at: the target's thread
 *  whose highlight covers exactly the selected text of `content` (the text the
 *  anchor was captured from), so quoting a range twice gives one thread. An
 *  exact one wins over one that only moved there. Else a new highlight.
 *
 *  ACCEPTED: the lookup runs before the creating tx, so two copies of the same
 *  range racing each other can leave a second, unreferenced highlight.
 *  ACCEPTED: once the words a discussion was on are gone, its moved anchor can
 *  settle on the same words elsewhere, and a copy there joins that discussion:
 *  it is the highlight the block draws there. */
export const threadForRange = async (
  repo: Repo,
  targetId: string,
  anchor: RangeAnchor,
  content: string,
): Promise<string> => {
  const target = await repo.load(targetId)
  if (!target) throw missingTarget(targetId)
  const threads = await repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId: target.workspaceId, id: targetId}).load()
  const covering = threads.flatMap(thread => {
    const range = highlightRange(content, thread)
    return range && range.from === anchor.quoteStart && range.to - range.from === anchor.quote.length
      ? [{id: thread.id, moved: range.moved}]
      : []
  })
  const existing = covering.find(candidate => !candidate.moved) ?? covering[0]
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
