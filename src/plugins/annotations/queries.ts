import {z} from 'zod'
import {defineQuery, type Schema} from '@/data/api'
import {TYPED_BLOCKS_STRUCTURE_CHANNEL, typedBlocksStructureKey} from '@/data/invalidation'
import {backlinkSourceIds} from '@/plugins/backlinks/sourceBatch.js'
import {annotationTargetProp} from './schema.ts'

export const THREAD_IDS_FOR_BLOCK_QUERY = 'annotations.threadIdsForBlock'

const stringArraySchema: Schema<string[]> = {parse: input => input as string[]}

/** Thread roots anchored to `id`, newest first. The target-edge projection of
 *  the backlinks batch, so every block in a render wave is answered by one
 *  statement; status and comments are read off the hydrated roots. */
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

declare module '@/data/api' {
  interface QueryRegistry {
    [THREAD_IDS_FOR_BLOCK_QUERY]: typeof threadIdsForBlockQuery
  }
}
