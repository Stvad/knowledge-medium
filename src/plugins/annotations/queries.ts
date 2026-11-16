import {z} from 'zod'
import {defineQuery, type Schema} from '@/data/api'
import {TYPED_BLOCKS_STRUCTURE_CHANNEL, typedBlocksStructureKey} from '@/data/invalidation'
import {backlinkSourceIds} from '@/plugins/backlinks/sourceBatch.js'
import {buildQualifiedBlockColumnsSql} from '@/data/blockSchema'
import {hasBlockType} from '@/data/properties'
import {annotationTargetProp, THREAD_TYPE, threadIsOpen, threadTargetIdOf} from './schema.ts'

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

/** A comment, in an open thread, that links a block by its content. */
export interface CommentLink {
  commentId: string
  threadId: string
}

const commentLinksSchema: Schema<CommentLink[]> = {parse: input => input as CommentLink[]}

/** From each source up to its nearest thread root, if it has one. Binds the
 *  sources as JSON, then the thread type. */
const NEAREST_THREAD_SQL = `
  WITH RECURSIVE up(source_id, id, parent_id, depth) AS (
    SELECT b.id, b.id, b.parent_id, 0 FROM json_each(?) j JOIN blocks b ON b.id = j.value AND b.deleted = 0
    UNION ALL
    SELECT up.source_id, p.id, p.parent_id, up.depth + 1
      FROM up JOIN blocks p ON p.id = up.parent_id AND p.deleted = 0
     WHERE up.depth < 100
  )
  SELECT up.source_id, up.id AS thread_id, MIN(up.depth) AS depth
    FROM up JOIN block_types t ON t.block_id = up.id AND t.type = ?
   GROUP BY up.source_id
`

const SELECT_LIVE_BLOCKS_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql('b')}
    FROM json_each(?) j
    JOIN blocks b ON b.id = j.value
   WHERE b.deleted = 0
`

/** The comments in open threads that link `id`, newest first, except those
 *  in `id`'s own threads, which its comment pill already shows. The block's
 *  mention sources (the backlinks batch), narrowed to comments. */
export const commentLinksForBlockQuery = defineQuery<{workspaceId: string; id: string}, CommentLink[]>({
  name: COMMENT_LINKS_FOR_BLOCK_QUERY,
  argsSchema: z.object({workspaceId: z.string(), id: z.string()}),
  resultSchema: commentLinksSchema,
  resolve: async ({workspaceId, id}, ctx) => {
    if (!workspaceId || !id) return []
    const sources = await backlinkSourceIds(ctx, workspaceId, id)
    if (sources.length === 0) return []
    for (const source of sources) {
      // A comment moved into or out of a thread.
      ctx.depend({kind: 'plugin', channel: TYPED_BLOCKS_STRUCTURE_CHANNEL, key: typedBlocksStructureKey(workspaceId, source)})
    }
    const nearest = await ctx.db.getAll<{source_id: string; thread_id: string}>(
      NEAREST_THREAD_SQL, [JSON.stringify(sources), THREAD_TYPE],
    )
    if (nearest.length === 0) return []
    const threadOf = new Map(nearest.map(row => [row.source_id, row.thread_id]))
    // Its status and target.
    for (const threadId of threadOf.values()) ctx.depend({kind: 'row', id: threadId})
    const roots = ctx.hydrateBlocks(await ctx.db.getAll<Record<string, unknown>>(
      SELECT_LIVE_BLOCKS_SQL, [JSON.stringify([...new Set(threadOf.values())])],
    ))
    const shown = new Set(roots
      .filter(root => hasBlockType(root, THREAD_TYPE) && threadIsOpen(root) && threadTargetIdOf(root) !== id)
      .map(root => root.id))
    return sources.flatMap(commentId => {
      const threadId = threadOf.get(commentId)
      return threadId !== undefined && commentId !== threadId && shown.has(threadId) ? [{commentId, threadId}] : []
    })
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [THREAD_IDS_FOR_BLOCK_QUERY]: typeof threadIdsForBlockQuery
    [COMMENT_LINKS_FOR_BLOCK_QUERY]: typeof commentLinksForBlockQuery
  }
}
