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
import {resolveAnchor, type RangeAnchor} from './anchor.ts'
import {anchorFromEditor} from './actions.ts'
import {THREADS_FOR_BLOCK_QUERY, type ThreadSummary} from './summaries.ts'
import {createThread, isThreadRefusal, missingTarget} from './threads.ts'

export const COPY_RANGE_REFERENCE_ACTION_ID = 'annotations.copyReferenceToSelection'

/** Is `thread` open and anchored exactly to `anchor`'s range of `content`? */
export const anchorsRange = (content: string, thread: ThreadSummary, anchor: RangeAnchor): boolean => {
  if (!thread.open || thread.anchor.kind !== 'range') return false
  const resolved = resolveAnchor(content, thread.anchor)
  return resolved.state === 'exact' &&
    resolved.from === anchor.quoteStart && resolved.to === anchor.quoteStart + anchor.quote.length
}

/** The thread a reference to `anchor` should point at: the target's open
 *  thread anchored exactly there, so quoting a range twice gives one thread,
 *  or else a new highlight. `content` is the text the anchor was captured
 *  from.
 *
 *  ACCEPTED: the lookup runs before the creating tx, so two copies of the same
 *  range racing each other can leave a second, unreferenced highlight. */
export const threadForRange = async (
  repo: Repo,
  targetId: string,
  content: string,
  anchor: RangeAnchor,
): Promise<string> => {
  const target = await repo.load(targetId)
  if (!target) throw missingTarget(targetId)
  const threads = await repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId: target.workspaceId, id: targetId}).load()
  const existing = threads.find(thread => anchorsRange(content, thread, anchor))
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
    const anchor = anchorFromEditor(editorView)
    if (!anchor) {
      showInfo('Select the text to quote.')
      return
    }
    let threadId: string
    try {
      threadId = await threadForRange(block.repo, block.id, editorView.state.doc.toString(), anchor)
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
