import {z} from 'zod'
import {defineQuery, type BlockData, type Query, type Schema} from '@/data/api'
import {hasBlockType} from '@/data/properties'
import {backlinkSourceIds} from '@/plugins/backlinks/sourceBatch.js'
import {THREAD_TYPE, threadTargetIdOf} from './schema.ts'

export const MENTIONS_FOR_BLOCK_QUERY = 'annotations.mentionsForBlock'
const MENTION_CARD_LIMIT = 3

export interface MarginMentions {
  ids: string[]
  total: number
  /** Root-first locations, from the same walks that decide membership. */
  parentsBySource: Record<string, string[]>
}

const resultSchema: Schema<MarginMentions> = {parse: input => input as MarginMentions}

/** Both reads already coalesce through ReadBatcher: backlink sources, then
 *  their ancestor walks. Filter before capping so comments already in this
 *  target's threads neither consume a card nor inflate the remaining count.
 *  The nearest root owns a comment; nested threads belong through their
 *  target, regardless of where their roots are stored. Inherited ancestor
 *  row dependencies keep moves and retargets reactive. */
export const mentionsForBlockQuery: Query<{workspaceId: string; id: string}, MarginMentions> = defineQuery({
  name: MENTIONS_FOR_BLOCK_QUERY,
  argsSchema: z.object({workspaceId: z.string(), id: z.string()}),
  resultSchema,
  resolve: async ({workspaceId, id}, ctx) => {
    const sources = await backlinkSourceIds(ctx, workspaceId, id)
    const walks = await Promise.all(sources.map(sourceId => ctx.run('core.ancestors', {id: sourceId})))
    const inTargetThread = async (ancestors: readonly BlockData[], seen: Set<string>): Promise<boolean> => {
      for (const root of ancestors) {
        if (!hasBlockType(root, THREAD_TYPE)) continue
        const targetId = threadTargetIdOf(root)
        if (!targetId) return false
        if (seen.has(root.id)) return false
        if (targetId === id) return true
        seen.add(root.id)
        const next = await ctx.run('core.ancestors', {id: targetId})
        return inTargetThread(next.ancestors, seen)
      }
      return false
    }
    const duplicate = await Promise.all(walks.map(walk => inTargetThread(walk.ancestors, new Set())))
    const ids = sources.filter((_, i) => !duplicate[i])
    const cards = ids.slice(0, MENTION_CARD_LIMIT)
    return {
      ids: cards,
      total: ids.length,
      parentsBySource: Object.fromEntries(cards.map(sourceId => [
        sourceId, walks[sources.indexOf(sourceId)].ancestors.map(parent => parent.id).reverse(),
      ])),
    }
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [MENTIONS_FOR_BLOCK_QUERY]: typeof mentionsForBlockQuery
  }
}
