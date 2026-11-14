/**
 * Backlink sources under a user filter: Linked References with filter chips,
 * `backlinks.forBlock` with `filter`, and grouped backlinks' filtered set.
 *
 * What counts as a source at all is decided once, by the batch
 * (`sourceBatch.ts`): self and the edges another surface owns are excluded
 * there, and an edge from inside a property subtree becomes its owner's. This
 * route only narrows that set by the filter, so the two can never disagree
 * about which edges count.
 *
 * The filter runs on the rows holding the edges, and a value row passing it
 * passes its owner. An ancestor-scoped predicate, which is all the chips write,
 * sees the owner's chain from there as well as the value row's own links. A
 * `self`-scoped one reads the value row, so it only sees an owner that has an
 * edge of its own: accepted, as only an explicit agent filter can say `self`.
 */

import type { QueryCtx } from '@/data/api'
import type { BacklinksFilter } from './query.ts'
import { registryRecognitionParams } from '@/data/internals/kernelQueries'
import { propertyMachineryOwners } from './machinery.ts'
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
  const owners = await propertyMachineryOwners(ctx.db, ids, registryRecognitionParams(ctx.repo))
  const matched = new Set(ids.map(id => owners.get(id) ?? id))
  return (await backlinkSourceIds(ctx, workspaceId, targetId)).filter(sourceId => matched.has(sourceId))
}
