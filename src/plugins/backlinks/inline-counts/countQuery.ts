import { z } from 'zod'
import { defineQuery, type Query, type Schema } from '@/data/api'
import {
  TYPED_BLOCKS_STRUCTURE_CHANNEL,
  typedBlocksStructureKey,
} from '@/data/invalidation'

export const BACKLINKS_COUNT_FOR_BLOCK_QUERY = 'backlinks.countForBlock'

const numberSchema: Schema<number> = {
  parse: (input) => input as number,
}

/** Backlink *count* for the inline badge — the cardinality of the unfiltered
 *  `backlinks.forBlock` set without materialising the id list. Drives through
 *  the same indexed `block_references` candidate set via `core.typedBlockCount`,
 *  so its membership and invalidation match `backlinks.forBlock` exactly, and
 *  excludes the self-reference in SQL with a self-scope `exclude` predicate —
 *  the SQL analogue of `forBlock`'s `ids.filter(s => s !== id)`.
 *
 *  Intentionally UNFILTERED, even though the expanded `LinkedReferences` may
 *  apply a page / daily-note backlink filter (rendered as "matched / total").
 *  The badge tracks the *total* — i.e. the denominator the user sees on
 *  expand — so "5" on the badge and "2 / 5" in the expanded header agree.
 *
 *  Explicit const type (like `backlinksForBlockQuery`) so `typeof` is knowable
 *  without inferring this initializer, which would loop through QueryRegistry
 *  via the `ctx.run` below. */
export const backlinksCountForBlockQuery: Query<
  { workspaceId: string; id: string },
  number
> = defineQuery<{ workspaceId: string; id: string }, number>({
  name: BACKLINKS_COUNT_FOR_BLOCK_QUERY,
  argsSchema: z.object({
    workspaceId: z.string(),
    id: z.string(),
  }),
  resultSchema: numberSchema,
  resolve: async ({ workspaceId, id }, ctx) => {
    if (!workspaceId || !id) return 0
    // Target structural dep — re-resolve when the target is deleted/restored,
    // mirroring `backlinksForBlockQuery`. The reference-channel dep comes free
    // from `referencedBy` via `core.typedBlockCount`.
    ctx.depend({
      kind: 'plugin',
      channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
      key: typedBlocksStructureKey(workspaceId, id),
    })
    return ctx.run('core.typedBlockCount', {
      workspaceId,
      referencedBy: { id },
      exclude: [{ scope: 'self', id }],
    })
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [BACKLINKS_COUNT_FOR_BLOCK_QUERY]: typeof backlinksCountForBlockQuery
  }
}
