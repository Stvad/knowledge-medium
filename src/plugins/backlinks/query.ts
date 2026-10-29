import { z } from 'zod'
import { isEqual } from 'lodash-es'
import {
  defineQuery,
  backlinksFilterSchema,
  type BlockPredicate,
  type Query,
  type Schema,
} from '@/data/api'
import {
  TYPED_BLOCKS_STRUCTURE_CHANNEL,
  typedBlocksStructureKey,
} from '@/data/invalidation'
import { backlinkSourceIds } from './sourceBatch.ts'
import { filteredBacklinkSourceIds } from './sources.ts'

export const BACKLINKS_FOR_BLOCK_QUERY = 'backlinks.forBlock'

/** Filter applied on top of the base "blocks that reference target X"
 *  set. Each entry is a `BlockPredicate` from the unified typed-query
 *  language — same shape `repo.queryBlocks({match, exclude})` accepts.
 *  Backlinks chips default `scope: 'ancestor'` (block-or-any-ancestor)
 *  to match the historical filter semantics. */
export interface BacklinksFilter {
  include?: BlockPredicate[]
  exclude?: BlockPredicate[]
}

const stringArraySchema: Schema<string[]> = {
  parse: (input) => input as string[],
}

const isPredicateMeaningful = (p: BlockPredicate): boolean => {
  const hasWhere = p.where !== undefined && Object.keys(p.where).length > 0
  const hasRef = p.referencedBy !== undefined
  const hasId = p.id !== undefined
  return hasWhere || hasRef || hasId
}

const stripEmpty = (
  predicates: readonly BlockPredicate[] | undefined,
): BlockPredicate[] =>
  (predicates ?? []).filter(isPredicateMeaningful)

export const normalizeBacklinksFilter = (
  filter: BacklinksFilter | undefined,
): Required<BacklinksFilter> => ({
  include: stripEmpty(filter?.include),
  exclude: stripEmpty(filter?.exclude),
})

const samePredicate = (a: BlockPredicate, b: BlockPredicate): boolean => isEqual(a, b)

/** Page-local filter overrides workspace defaults. The merge rules:
 *   - everything the page added (include or exclude) wins outright
 *   - default predicates carry through unless the page added the same
 *     predicate to the opposite list (e.g. workspace removes [[done]],
 *     this page wants to include it). */
export const mergeBacklinksFilters = (
  defaults: BacklinksFilter | undefined,
  overrides: BacklinksFilter | undefined,
): Required<BacklinksFilter> => {
  const d = normalizeBacklinksFilter(defaults)
  const o = normalizeBacklinksFilter(overrides)

  const include = [
    ...o.include,
    ...d.include.filter(p => !o.exclude.some(other => samePredicate(p, other))),
  ]
  const exclude = [
    ...o.exclude,
    ...d.exclude.filter(p => !o.include.some(other => samePredicate(p, other))),
  ]
  return normalizeBacklinksFilter({include, exclude})
}

export const hasBacklinksFilter = (filter: BacklinksFilter | undefined): boolean => {
  const n = normalizeBacklinksFilter(filter)
  return n.include.length > 0 || n.exclude.length > 0
}

/** Backlinks: blocks whose references point at `id`, self-reference excluded.
 *  Unfiltered, it is answered by the inline badge's batched statement
 *  (`sourceBatch.ts`), so the list on expand and the count on the badge are two
 *  projections of one query. Filtered (or `rawSources`), it goes through
 *  `sources.ts`, the same owner grouped backlinks uses. */
// Explicit const type so `typeof backlinksForBlockQuery` (it augments
// QueryRegistry below) is knowable without inferring this initializer —
// otherwise the `ctx.run` call here resolves QueryRegistry, which loops
// back through this query's own type.
export const backlinksForBlockQuery: Query<
  {workspaceId: string; id: string; filter?: BacklinksFilter; rawSources?: boolean},
  string[]
> = defineQuery<
  {workspaceId: string; id: string; filter?: BacklinksFilter; rawSources?: boolean},
  string[]
>({
  name: BACKLINKS_FOR_BLOCK_QUERY,
  argsSchema: z.object({
    workspaceId: z.string(),
    id: z.string(),
    filter: backlinksFilterSchema.optional(),
    // Default (false): exclude property-machinery sources — a `[[Foo]]`
    // property VALUE mints its backlink through the owning block's cell
    // reprojection, so surfacing the hidden value row too would double it and
    // attribute one copy to invisible machinery — and the edges another surface
    // owns (`edgeExclusions.ts`). `true` returns EVERY source (the raw
    // `block_references` view), for inspection / debugging. Reference
    // maintenance never goes through this query — it reads `block_references`
    // directly — so filtering here is display-only, never a correctness risk.
    rawSources: z.boolean().optional(),
  }),
  resultSchema: stringArraySchema,
  resolve: async ({workspaceId, id, filter, rawSources}, ctx) => {
    if (!workspaceId || !id) return []
    // Target structural dep — re-resolve when the target itself is
    // deleted/restored without making target content part of the
    // collection query contract.
    ctx.depend({
      kind: 'plugin',
      channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
      key: typedBlocksStructureKey(workspaceId, id),
    })
    const normalized = normalizeBacklinksFilter(filter)
    if (!rawSources && normalized.include.length === 0 && normalized.exclude.length === 0) {
      return backlinkSourceIds(ctx, workspaceId, id)
    }
    return filteredBacklinkSourceIds(ctx, workspaceId, id, normalized, {raw: rawSources})
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [BACKLINKS_FOR_BLOCK_QUERY]: typeof backlinksForBlockQuery
  }
}
