import { z } from 'zod'
import { defineQuery, type Query, type Schema } from '@/data/api'
import {
  TYPED_BLOCKS_STRUCTURE_CHANNEL,
  typedBlocksStructureKey,
} from '@/data/invalidation'
import { BACKLINKS_FOR_BLOCK_QUERY, workspaceHasPropertyMachinery } from '../query.ts'

export const BACKLINKS_COUNT_FOR_BLOCK_QUERY = 'backlinks.countForBlock'

const numberSchema: Schema<number> = {
  parse: (input) => input as number,
}

/** Backlink *count* for the inline badge — the cardinality of the unfiltered
 *  `backlinks.forBlock` set, obtained by resolving that query and taking its
 *  length, so membership and invalidation match it by construction.
 *
 *  — but only where machinery can exist. Otherwise it aggregates in SQL
 *  (`core.typedBlockCount`) without materialising the id list at all. See the
 *  property-machinery paragraph below.
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
 *  expand. That exclusion is a post-filter on ids, so counting it means
 *  materialising them — which is why the id-list path exists at all. The
 *  condition it sits behind used to be the workspace flip, on the premise that
 *  only a flipped workspace holds machinery; the cell->children backfill mints
 *  it before the flip, and the badge then counted a hidden value row the
 *  expanded list did not (2 on the badge, 1 in the list). It now asks the
 *  rows.
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
    // Two paths, keyed on the DATA rather than on the flip. The exclusion is a
    // post-filter on ids, so a count that applies it has to materialize them —
    // and badge/list parity is not optional (2 on the badge, 1 in the list, on
    // every page with a ref-typed property pointing at the target). But with no
    // machinery in the workspace the filter is provably a no-op, and then the
    // SQL aggregate is both cheaper and exactly equal.
    //
    // The old gate asked `properties_migration`, on the premise that only a
    // flipped workspace holds machinery. The backfill mints it before the flip,
    // which is why this asks the rows instead.
    if (await workspaceHasPropertyMachinery(ctx.db, workspaceId)) {
      return (await ctx.run(BACKLINKS_FOR_BLOCK_QUERY, { workspaceId, id })).length
    }
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
