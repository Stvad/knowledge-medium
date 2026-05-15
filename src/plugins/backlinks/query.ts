import { z } from 'zod'
import {
  defineQuery,
  type BlockData,
  type BlockPredicate,
  type Schema,
} from '@/data/api'
import { resolveTypedBlocks } from '@/data/internals/kernelQueries.ts'

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

const referenceFilterSchema = z.object({
  id: z.string(),
  sourceField: z.string().optional(),
})

const blockPredicateSchema = z.object({
  scope: z.enum(['self', 'ancestor']).optional(),
  id: z.string().optional(),
  where: z.record(z.string(), z.unknown()).optional(),
  referencedBy: referenceFilterSchema.optional(),
})

const backlinksFilterSchema = z.object({
  include: z.array(blockPredicateSchema).optional(),
  exclude: z.array(blockPredicateSchema).optional(),
}).optional()

const blockDataArraySchema: Schema<BlockData[]> = {
  parse: (input) => input as BlockData[],
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

const samePredicate = (a: BlockPredicate, b: BlockPredicate): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

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
export const backlinksForBlockQuery = defineQuery<
  {workspaceId: string; id: string; filter?: BacklinksFilter},
  BlockData[]
>({
  name: BACKLINKS_FOR_BLOCK_QUERY,
  argsSchema: z.object({
    workspaceId: z.string(),
    id: z.string(),
    filter: backlinksFilterSchema,
  }),
  resultSchema: blockDataArraySchema,
  resolve: async ({workspaceId, id, filter}, ctx) => {
    if (!workspaceId || !id) return []
    // Target row dep — re-resolve when the target itself changes
    // (e.g. soft-delete). The typed-blocks reference channel only
    // fires on incoming-edge diffs, not on target-row writes.
    ctx.depend({kind: 'row', id})
    const normalized = normalizeBacklinksFilter(filter)
    const rows = await resolveTypedBlocks({
      workspaceId,
      referencedBy: {id},
      match: normalized.include,
      exclude: normalized.exclude,
      order: 'created-desc',
    }, ctx)
    return rows.filter(r => r.id !== id)
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [BACKLINKS_FOR_BLOCK_QUERY]: typeof backlinksForBlockQuery
  }
}
