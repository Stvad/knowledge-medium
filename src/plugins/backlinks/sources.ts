/**
 * Backlink sources under a user filter: Linked References with filter chips,
 * `backlinks.forBlock` with `filter`, and grouped backlinks' filtered set.
 *
 * What counts as a source at all is decided once, by the batch
 * (`sourceBatch.ts`): self, the edges another surface owns and property
 * machinery are excluded there. This route only narrows that set by the
 * filter, so the two can never disagree about which edges count.
 */

import type { QueryCtx } from '@/data/api'
import type { BacklinksFilter } from './query.ts'
import { backlinkSourceIds } from './sourceBatch.ts'

/** Sources of `targetId` that match `filter`, newest first. `raw` returns
 *  every source the index holds, for inspection: nothing excluded. */
export const filteredBacklinkSourceIds = async (
  ctx: QueryCtx,
  workspaceId: string,
  targetId: string,
  filter: Required<BacklinksFilter>,
  {raw = false}: {raw?: boolean} = {},
): Promise<string[]> => {
  const ids = (await ctx.run('core.typedBlockIds', {
    workspaceId,
    referencedBy: {id: targetId},
    match: filter.include,
    exclude: filter.exclude,
    order: 'created-desc',
  })).filter(sourceId => sourceId !== targetId)
  if (raw || ids.length === 0) return ids
  const sources = new Set(await backlinkSourceIds(ctx, workspaceId, targetId))
  return ids.filter(sourceId => sources.has(sourceId))
}
