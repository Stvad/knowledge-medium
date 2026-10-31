/**
 * Quoting part of a block. A range reference is no new syntax: it is an
 * ordinary `((T))` to a thread root T anchored to that range, and T renders
 * as the quote wherever it is referenced (`quotedRange.tsx`).
 */

import type {Repo} from '@/data/repo'
import type {RangeAnchor} from './anchor.ts'
import {highlightRange} from './highlights.ts'
import {THREADS_FOR_BLOCK_QUERY} from './summaries.ts'
import {createThread, missingTarget} from './threads.ts'

/** The thread a reference to `anchor` should point at: the target's thread
 *  whose highlight covers exactly the selected text of `content` (the text the
 *  anchor was captured from), so quoting a range twice gives one thread. An
 *  exact one wins over one that only moved there. Never an edit suggestion,
 *  whose accept replaces the text this would quote. Else a new highlight.
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
    const range = thread.suggestion ? null : highlightRange(content, thread)
    return range && range.from === anchor.quoteStart && range.to - range.from === anchor.quote.length
      ? [{id: thread.id, moved: range.moved}]
      : []
  })
  const existing = covering.find(candidate => !candidate.moved) ?? covering[0]
  if (existing) return existing.id
  const created = await createThread(repo, {targetId, anchor}, {description: 'copy reference to selection'})
  return created.threadId
}
