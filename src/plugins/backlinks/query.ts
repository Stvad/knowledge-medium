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

/** Backlinks: blocks whose references point at `id`. Thin wrapper
 *  around `resolveTypedBlocks` — the typed-query compiler drives from
 *  the indexed `block_references` lookup when `referencedBy` is set,
 *  preserving the perf shape of the previous dedicated SQL.
 *
 *  Self-reference (the target block referencing itself) is filtered
 *  out post-fetch — it's a one-line check, not worth a special SQL
 *  predicate. */
// Explicit const type so `typeof backlinksForBlockQuery` (it augments
// QueryRegistry below) is knowable without inferring this initializer —
// otherwise the `ctx.run` call here resolves QueryRegistry, which loops
// back through this query's own type.
export const backlinksForBlockQuery: Query<
  {workspaceId: string; id: string; filter?: BacklinksFilter},
  string[]
> = defineQuery<
  {workspaceId: string; id: string; filter?: BacklinksFilter},
  string[]
>({
  name: BACKLINKS_FOR_BLOCK_QUERY,
  argsSchema: z.object({
    workspaceId: z.string(),
    id: z.string(),
    filter: backlinksFilterSchema.optional(),
  }),
  resultSchema: stringArraySchema,
  resolve: async ({workspaceId, id, filter}, ctx) => {
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
    const ids = await ctx.run('core.typedBlockIds', {
      workspaceId,
      referencedBy: {id},
      match: normalized.include,
      exclude: normalized.exclude,
      order: 'created-desc',
    })
    return ids.filter(sourceId => sourceId !== id)
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [BACKLINKS_FOR_BLOCK_QUERY]: typeof backlinksForBlockQuery
  }
}
