import {z} from 'zod'
import {defineQuery, type Query, type Schema} from '@/data/api'
import {hasBlockType} from '@/data/properties'
import {THREAD_IDS_FOR_BLOCK_QUERY} from './queries.ts'
import {THREAD_TYPE, threadAnchorOf, threadIsOpen, threadSuggestionOf, type ThreadAnchor} from './schema.ts'
import {threadRootsWithCounts} from './summaryBatch.ts'

export const THREADS_FOR_BLOCK_QUERY = 'annotations.threadsForBlock'

export interface ThreadSummary {
  id: string
  open: boolean
  anchor: ThreadAnchor
  /** An edit suggestion, highlighted in a style of its own. */
  suggestion: boolean
  commentCount: number
  createdAt: number
}

/** Does this thread count in its target's comment pill? A pure highlight (no
 *  comments) shows only as its highlight; an open suggestion counts with or
 *  without comments, since it waits on someone to accept or reject it. */
export const countsInPill = (thread: ThreadSummary): boolean =>
  thread.open && (thread.commentCount > 0 || thread.suggestion)

/** The number on a block's comment pill, or null for no pill: a block with no
 *  threads. A block whose threads are all highlights or resolved gets an
 *  unnumbered pill (0), so they stay reachable. */
export const pillCount = (threads: readonly ThreadSummary[]): number | null =>
  threads.length === 0 ? null : threads.filter(countsInPill).length

/** What a highlight reads off a thread. */
export type HighlightThread = Pick<ThreadSummary, 'id' | 'open' | 'anchor' | 'suggestion'>

/** Does this thread draw a highlight over its quote? Every open range thread
 *  does, comments or not, as decided for now; it may narrow to threads with
 *  comments, quoters or a replacement. This is the one place that decides it. */
export const drawsHighlight = (thread: HighlightThread): boolean => thread.open && thread.anchor.kind === 'range'

/** Whole-block threads first, then by where the quote started, then oldest
 *  first. */
const byPosition = (a: ThreadSummary, b: ThreadSummary): number => {
  const start = (t: ThreadSummary) => t.anchor.kind === 'block' ? -1 : t.anchor.quoteStart ?? Number.MAX_SAFE_INTEGER
  return start(a) - start(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}

const summariesSchema: Schema<ThreadSummary[]> = {parse: input => input as ThreadSummary[]}

/** The threads anchored to a block, each with what the pill, the inline
 *  section and the highlights read off it. Re-resolves on a new or removed
 *  thread (the target edge), on a root's own edit (its row) and on a comment
 *  added or removed at the top of a thread (the root's children). The roots
 *  and their counts for a whole render wave are one statement
 *  (`summaryBatch.ts`). */
// Explicit type: `ctx.run` below resolves QueryRegistry, which this query
// augments, so an inferred type would loop back through itself.
export const threadsForBlockQuery: Query<{workspaceId: string; id: string}, ThreadSummary[]> =
  defineQuery<{workspaceId: string; id: string}, ThreadSummary[]>({
  name: THREADS_FOR_BLOCK_QUERY,
  argsSchema: z.object({workspaceId: z.string(), id: z.string()}),
  resultSchema: summariesSchema,
  resolve: async ({workspaceId, id}, ctx) => {
    const ids = await ctx.run(THREAD_IDS_FOR_BLOCK_QUERY, {workspaceId, id})
    if (ids.length === 0) return []
    return (await threadRootsWithCounts(ctx, ids))
      .filter(({root}) => hasBlockType(root, THREAD_TYPE))
      .map(({root, commentCount}) => ({
        id: root.id,
        open: threadIsOpen(root),
        anchor: threadAnchorOf(root),
        suggestion: threadSuggestionOf(root) !== null,
        commentCount,
        createdAt: root.createdAt,
      }))
      .sort(byPosition)
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [THREADS_FOR_BLOCK_QUERY]: typeof threadsForBlockQuery
  }
}
