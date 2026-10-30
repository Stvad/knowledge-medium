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
import {anchorFromEditor} from './actions.ts'
import {THREADS_FOR_BLOCK_QUERY, type ThreadSummary} from './summaries.ts'
import {createThread, isThreadRefusal, missingTarget} from './threads.ts'

export const COPY_RANGE_REFERENCE_ACTION_ID = 'annotations.copyReferenceToSelection'

/** Is `thread` open and anchored exactly to `anchor`'s range? A captured
 *  anchor is exact against the text it came from, so a thread exact on the
 *  same range of that text has the same quote, start and context. */
const anchorsRange = (thread: ThreadSummary, anchor: RangeAnchor): boolean =>
  thread.open && thread.anchor.kind === 'range' &&
  thread.anchor.quote === anchor.quote && thread.anchor.quoteStart === anchor.quoteStart &&
  thread.anchor.prefix === anchor.prefix && thread.anchor.suffix === anchor.suffix

/** The thread a reference to `anchor` should point at: the target's open
 *  thread anchored exactly there, so quoting a range twice gives one thread,
 *  or else a new highlight.
 *
 *  ACCEPTED: the lookup runs before the creating tx, so two copies of the same
 *  range racing each other can leave a second, unreferenced highlight. */
export const threadForRange = async (repo: Repo, targetId: string, anchor: RangeAnchor): Promise<string> => {
  const target = await repo.load(targetId)
  if (!target) throw missingTarget(targetId)
  const threads = await repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId: target.workspaceId, id: targetId}).load()
  const existing = threads.find(thread => anchorsRange(thread, anchor))
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
      threadId = await threadForRange(block.repo, block.id, anchor)
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
