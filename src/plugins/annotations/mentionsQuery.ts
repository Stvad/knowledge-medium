import {z} from 'zod'
import {defineQuery, type Query, type Schema} from '@/data/api'
import {backlinkSourceIds} from '@/plugins/backlinks/sourceBatch.js'
import {mentionThreadBlockIds} from './mentionThreads.ts'

export const MENTIONS_FOR_BLOCK_QUERY = 'annotations.mentionsForBlock'
const MENTION_CARD_LIMIT = 3

export interface MarginMentions {
  ids: string[]
  total: number
  /** Root-first locations of only the displayed sources. */
  parentsBySource: Record<string, string[]>
}

const resultSchema: Schema<MarginMentions> = {parse: input => input as MarginMentions}

/** Filter the source owner's list against the target's thread subtrees before
 *  capping. Only displayed sources need ancestor walks for their breadcrumbs;
 *  both the source and thread-subtree reads coalesce across a render wave. */
export const mentionsForBlockQuery: Query<{workspaceId: string; id: string}, MarginMentions> = defineQuery({
  name: MENTIONS_FOR_BLOCK_QUERY,
  argsSchema: z.object({workspaceId: z.string(), id: z.string()}),
  resultSchema,
  resolve: async ({workspaceId, id}, ctx) => {
    const [sources, ownThreads] = await Promise.all([
      backlinkSourceIds(ctx, workspaceId, id),
      mentionThreadBlockIds(ctx, workspaceId, id),
    ])
    const ids = sources.filter(sourceId => !ownThreads.has(sourceId))
    const cards = ids.slice(0, MENTION_CARD_LIMIT)
    const walks = await Promise.all(cards.map(sourceId => ctx.run('core.ancestors', {id: sourceId})))
    return {
      ids: cards,
      total: ids.length,
      parentsBySource: Object.fromEntries(cards.map((sourceId, i) => [
        sourceId, walks[i].ancestors.map(parent => parent.id).reverse(),
      ])),
    }
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [MENTIONS_FOR_BLOCK_QUERY]: typeof mentionsForBlockQuery
  }
}
