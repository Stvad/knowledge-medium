import {z} from 'zod'
import {defineQuery, type Query, type Schema} from '@/data/api'
import {TYPED_BLOCKS_STRUCTURE_CHANNEL, typedBlocksStructureKey} from '@/data/invalidation'
import {backlinkSourceIds} from '@/plugins/backlinks/sourceBatch.js'
import {annotationTargetProp, threadIsOpen, threadTargetIdOf} from './schema.ts'
import {SELECT_LIVE_BLOCKS_SQL} from './scopeThreads.ts'
import {commentThreadOf, linkedBlockIds} from './threads.ts'

export const THREAD_IDS_FOR_BLOCK_QUERY = 'annotations.threadIdsForBlock'

const stringArraySchema: Schema<string[]> = {parse: input => input as string[]}

/** Thread roots anchored to `id`, newest first. The target-edge projection of
 *  the backlinks batch, so every block in a render wave is answered by one
 *  statement. */
export const threadIdsForBlockQuery = defineQuery<{workspaceId: string; id: string}, string[]>({
  name: THREAD_IDS_FOR_BLOCK_QUERY,
  argsSchema: z.object({workspaceId: z.string(), id: z.string()}),
  resultSchema: stringArraySchema,
  resolve: async ({workspaceId, id}, ctx) => {
    if (!workspaceId || !id) return []
    ctx.depend({
      kind: 'plugin',
      channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
      key: typedBlocksStructureKey(workspaceId, id),
    })
    return backlinkSourceIds(ctx, workspaceId, id, {field: annotationTargetProp.name})
  },
})

export const COMMENT_LINKS_FOR_BLOCK_QUERY = 'annotations.commentLinksForBlock'

/** A comment, in an open thread, that links a block. */
export interface CommentLink {
  commentId: string
  threadId: string
}

const commentLinksSchema: Schema<CommentLink[]> = {parse: input => input as CommentLink[]}

/** The comments in open threads that link `id` (`linkedBlockIds`), newest
 *  first, except those in `id`'s own threads, which its comment pill already
 *  shows. The block's mention sources (the backlinks batch), narrowed to
 *  comments; each one's thread comes from its `core.ancestors`, which keeps
 *  the walk's invalidation (a comment above it moving, a root resolved). */
export const commentLinksForBlockQuery: Query<{workspaceId: string; id: string}, CommentLink[]> =
  defineQuery<{workspaceId: string; id: string}, CommentLink[]>({
  name: COMMENT_LINKS_FOR_BLOCK_QUERY,
  argsSchema: z.object({workspaceId: z.string(), id: z.string()}),
  resultSchema: commentLinksSchema,
  resolve: async ({workspaceId, id}, ctx) => {
    if (!workspaceId || !id) return []
    const sources = await backlinkSourceIds(ctx, workspaceId, id)
    if (sources.length === 0) return []
    const linking = ctx.hydrateBlocks(await ctx.db.getAll<Record<string, unknown>>(
      SELECT_LIVE_BLOCKS_SQL, [JSON.stringify(sources)],
    )).filter(source => linkedBlockIds(source).includes(id))
    const order = new Map(sources.map((source, i) => [source, i]))
    const links = await Promise.all(linking.map(async source => {
      const {ancestors} = await ctx.run('core.ancestors', {id: source.id})
      const thread = commentThreadOf(source, ancestors)
      return thread && threadIsOpen(thread) && threadTargetIdOf(thread) !== id
        ? {commentId: source.id, threadId: thread.id}
        : null
    }))
    return links
      .filter((link): link is CommentLink => link !== null)
      .sort((a, b) => order.get(a.commentId)! - order.get(b.commentId)!)
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [THREAD_IDS_FOR_BLOCK_QUERY]: typeof threadIdsForBlockQuery
    [COMMENT_LINKS_FOR_BLOCK_QUERY]: typeof commentLinksForBlockQuery
  }
}
