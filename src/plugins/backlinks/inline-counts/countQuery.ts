import { z } from 'zod'
import { defineQuery, type Schema } from '@/data/api'
import {
  TYPED_BLOCKS_STRUCTURE_CHANNEL,
  typedBlocksStructureKey,
} from '@/data/invalidation'
import { backlinkSourceCount } from '../sourceBatch.ts'

export const BACKLINKS_COUNT_FOR_BLOCK_QUERY = 'backlinks.countForBlock'

const numberSchema: Schema<number> = {
  parse: (input) => input as number,
}

/** Backlink *count* for the inline badge: how many sources the unfiltered
 *  `backlinks.forBlock` list holds. Both are projections of one batched
 *  statement (`sourceBatch.ts`) — a count here, the ids there — so membership,
 *  the property-machinery exclusion and invalidation match by construction,
 *  and every badge in a wave of visible blocks is answered by one read.
 *
 *  Intentionally unfiltered with respect to the USER filter, even though the
 *  expanded `LinkedReferences` may apply a page / daily-note backlink filter
 *  (rendered as "matched / total"). The badge tracks the *total* — i.e. the
 *  denominator the user sees on expand — so "5" on the badge and "2 / 5" in the
 *  expanded header agree.
 *
 *  The property-machinery exclusion is a DIFFERENT axis and must apply here: it
 *  is source de-duplication, not a user filter, so a hidden value row's
 *  `[[Target]]` must not inflate the badge past the list the user gets on
 *  expand. */
export const backlinksCountForBlockQuery = defineQuery<{ workspaceId: string; id: string }, number>({
  name: BACKLINKS_COUNT_FOR_BLOCK_QUERY,
  argsSchema: z.object({
    workspaceId: z.string(),
    id: z.string(),
  }),
  resultSchema: numberSchema,
  resolve: async ({ workspaceId, id }, ctx) => {
    if (!workspaceId || !id) return 0
    // Target structural dep — re-resolve when the target is deleted/restored,
    // mirroring `backlinksForBlockQuery`.
    ctx.depend({
      kind: 'plugin',
      channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
      key: typedBlocksStructureKey(workspaceId, id),
    })
    return backlinkSourceCount(ctx, workspaceId, id)
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [BACKLINKS_COUNT_FOR_BLOCK_QUERY]: typeof backlinksCountForBlockQuery
  }
}
