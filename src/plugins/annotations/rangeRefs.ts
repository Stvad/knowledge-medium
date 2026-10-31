/**
 * Quoting part of a block. A range reference is no new syntax: it is an
 * ordinary `((T))` to a thread root T anchored to that range, and T renders
 * as the quote wherever it is referenced (`quotedRange.tsx`).
 */

import type {Repo} from '@/data/repo'
import {resolveAnchor, type AnchorResolution, type RangeAnchor} from './anchor.ts'
import {THREADS_FOR_BLOCK_QUERY, type ThreadSummary} from './summaries.ts'
import {createThread, missingTarget} from './threads.ts'

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
