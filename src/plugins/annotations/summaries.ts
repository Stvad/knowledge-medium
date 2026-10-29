import {z} from 'zod'
import {defineQuery, type Query, type Schema} from '@/data/api'
import {buildQualifiedBlockColumnsSql} from '@/data/blockSchema'
import {hasBlockType} from '@/data/properties'
import {THREAD_IDS_FOR_BLOCK_QUERY} from './queries.ts'
import {THREAD_TYPE, threadAnchorOf, threadIsOpen, type ThreadAnchor} from './schema.ts'

export const THREADS_FOR_BLOCK_QUERY = 'annotations.threadsForBlock'

export interface ThreadSummary {
  id: string
  open: boolean
  anchor: ThreadAnchor
  commentCount: number
  createdAt: number
}

/** Does this thread count in its target's comment pill? A pure highlight (no
 *  comments) shows only as its highlight. */
export const countsInPill = (thread: ThreadSummary): boolean => thread.open && thread.commentCount > 0

/** Does this thread draw a highlight over its quote? Whether a thread with no
 *  comments should is still open; this is the one place that decides it. */
export const drawsHighlight = (thread: ThreadSummary): boolean => thread.open && thread.anchor.kind === 'range'

/** Whole-block threads first, then by where the quote started, then oldest
 *  first. */
const byPosition = (a: ThreadSummary, b: ThreadSummary): number => {
  const start = (t: ThreadSummary) => t.anchor.kind === 'block' ? -1 : t.anchor.quoteStart ?? Number.MAX_SAFE_INTEGER
  return start(a) - start(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}

const SELECT_ROOTS_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql('b')}
    FROM json_each(?) j
    JOIN blocks b ON b.id = j.value
   WHERE b.deleted = 0
`

const summariesSchema: Schema<ThreadSummary[]> = {parse: input => input as ThreadSummary[]}

/** The threads anchored to a block, each with what the pill, the inline
 *  section and the highlights read off it. Re-resolves on a new or removed
 *  thread (the target edge), on a root's own edit (its row) and on a comment
 *  added or removed at the top of a thread (the root's children). */
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
    const rows = await ctx.db.getAll<Record<string, unknown>>(SELECT_ROOTS_SQL, [JSON.stringify(ids)])
    const roots = ctx.hydrateBlocks(rows).filter(root => hasBlockType(root, THREAD_TYPE))
    const summaries = await Promise.all(roots.map(async root => ({
      id: root.id,
      open: threadIsOpen(root),
      anchor: threadAnchorOf(root),
      commentCount: (await ctx.run('core.childIds', {id: root.id, hidePropertyChildren: true})).length,
      createdAt: root.createdAt,
    })))
    return summaries.sort(byPosition)
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [THREADS_FOR_BLOCK_QUERY]: typeof threadsForBlockQuery
  }
}
