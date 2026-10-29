/**
 * Backlink sources for the routes the batch does not answer: a user filter
 * (Linked References chips, `backlinks.forBlock` with `filter`) and grouped
 * backlinks. Together with `sourceBatch.ts` this is the one owner of what a
 * backlink source is: the same edge exclusions (`edgeExclusions.ts`) and the
 * same property-machinery exclusion, on every route.
 */

import type { QueryCtx } from '@/data/api'
import { dependOnRecognitionParams } from '@/data/internals/kernelQueries'
import { edgePredicate } from './edgeExclusions.ts'
import { propertyMachinerySourceIds, workspaceHasPropertyMachinery } from './machinery.ts'
import type { BacklinksFilter } from './query.ts'

/** `ids` that reach `targetId` through at least one counted edge, in order. A
 *  source referencing the target twice — once through an excluded edge, once
 *  in its own text — stays. One JSON-array bind, so no parameter ceiling. */
const withMentionEdge = async (
  ctx: QueryCtx,
  workspaceId: string,
  targetId: string,
  ids: string[],
): Promise<string[]> => {
  const edges = edgePredicate(ctx.repo, 'mentions')
  if (edges.admitsAll) return ids
  const rows = await ctx.db.getAll<{id: string}>(
    `SELECT DISTINCT br.source_id AS id
       FROM block_references br
      WHERE br.workspace_id = ?
        AND br.target_id = ?
        AND br.source_id IN (SELECT value FROM json_each(?))
        AND (${edges.sql})`,
    [workspaceId, targetId, JSON.stringify(ids), ...edges.params],
  )
  const kept = new Set(rows.map(row => row.id))
  return ids.filter(id => kept.has(id))
}

/** Sources of `targetId`, newest first, self excluded, narrowed by `filter`.
 *  `raw` returns every source the index holds, for inspection: no edge or
 *  machinery exclusion.
 *
 *  KNOWN, pre-existing: the machinery exclusion walks each SOURCE's ancestry
 *  with no dependency declared on it, so moving a source out from under a
 *  field row leaves a mounted list stale until its next reference change
 *  (km-nc46). */
export const filteredBacklinkSourceIds = async (
  ctx: QueryCtx,
  workspaceId: string,
  targetId: string,
  filter?: Required<BacklinksFilter>,
  {raw = false}: {raw?: boolean} = {},
): Promise<string[]> => {
  const ids = (await ctx.run('core.typedBlockIds', {
    workspaceId,
    referencedBy: {id: targetId},
    match: filter?.include,
    exclude: filter?.exclude,
    order: 'created-desc',
  })).filter(sourceId => sourceId !== targetId)
  if (raw || ids.length === 0) return ids
  const mentions = await withMentionEdge(ctx, workspaceId, targetId, ids)
  // Not flip-gated: the cell→children backfill mints value rows while the
  // workspace still reads cells, and a ref-typed value row's `[[X]]` then
  // duplicates the owner's projected property edge.
  if (mentions.length === 0 || !(await workspaceHasPropertyMachinery(ctx.db, workspaceId))) return mentions
  const machinery = await propertyMachinerySourceIds(ctx.db, mentions, dependOnRecognitionParams(ctx))
  return machinery.size === 0 ? mentions : mentions.filter(sourceId => !machinery.has(sourceId))
}
