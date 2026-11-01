import {z} from 'zod'
import {defineQuery, type Query, type Schema} from '@/data/api'
import {hasBlockType} from '@/data/properties'
import {backlinkSourceIds} from '@/plugins/backlinks/sourceBatch.js'
import {THREAD_TYPE, threadTargetIdOf} from './schema.ts'

export const MENTIONS_FOR_BLOCK_QUERY = 'annotations.mentionsForBlock'
const MENTION_CARD_LIMIT = 3

export interface MarginMentions {
  ids: string[]
  total: number
}

const resultSchema: Schema<MarginMentions> = {parse: input => input as MarginMentions}

/** Both reads already coalesce through ReadBatcher: backlink sources, then
 *  their ancestor walks. Filter before capping so comments already in this
 *  target's threads neither consume a card nor inflate the remaining count.
 *  Inherited ancestor row dependencies keep moves and retargets reactive. */
export const mentionsForBlockQuery: Query<{workspaceId: string; id: string}, MarginMentions> = defineQuery({
  name: MENTIONS_FOR_BLOCK_QUERY,
  argsSchema: z.object({workspaceId: z.string(), id: z.string()}),
  resultSchema,
  resolve: async ({workspaceId, id}, ctx) => {
    const sources = await backlinkSourceIds(ctx, workspaceId, id)
    const walks = await Promise.all(sources.map(sourceId => ctx.run('core.ancestors', {id: sourceId})))
    const ids = sources.filter((_, i) => !walks[i].ancestors.some(ancestor =>
      hasBlockType(ancestor, THREAD_TYPE) && threadTargetIdOf(ancestor) === id,
    ))
    return {ids: ids.slice(0, MENTION_CARD_LIMIT), total: ids.length}
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [MENTIONS_FOR_BLOCK_QUERY]: typeof mentionsForBlockQuery
  }
}
