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
import { readIsChildBackedWorkspace } from '@/data/workspaceSchema'

export const BACKLINKS_FOR_BLOCK_QUERY = 'backlinks.forBlock'

/** The seed `IN (?, …)` list binds one variable per source id, so a heavily
 *  backlinked block must be chunked under SQLite's `SQLITE_MAX_VARIABLE_NUMBER`
 *  (999 on older builds, 32766 since 3.32) — the same discipline the sync
 *  observer's staging reads use (`materialize.ts`). 500 keeps a wide margin. */
const MACHINERY_SOURCE_CHUNK = 500

/** Which of `sourceIds` are property-subtree INTERIOR machinery — a value child,
 *  or a row deeper inside a property subtree, whose parent chain passes through
 *  a §9 field row. Same recognition as `VISIBLE_CHILD_PREDICATE_SQL`: a
 *  workspace-scoped `block_types = 'property-schema'` probe on a non-null
 *  `reference_target_id`, root rows exempt via `parent_id IS NOT NULL`.
 *
 *  STRICTLY INTERIOR (`depth > 0`): the field row ITSELF is deliberately NOT
 *  matched. The de-dup this filter exists for only applies to interiors — a
 *  value row's `[[X]]` duplicates the owner's reprojected `O --prop--> X`, so
 *  showing both would state one fact twice and attribute a copy to a hidden
 *  row. A field row has no such duplicate: its only edge is to its OWN
 *  definition, which is the "used by" backlink (every block using this
 *  property), and nothing else projects that edge. Suppressing it would make a
 *  property definition's backlinks empty — the opposite of why field rows were
 *  put in `block_references` in the first place.
 *
 *  PRECONDITION — the caller MUST flip-gate this. There is no internal
 *  `properties_migration` check (unlike `VISIBLE_CHILD_PREDICATE_SQL`, which
 *  embeds one), because `reference_target_id` derivation and `property-schema`
 *  types both exist independent of the flip. Calling it for an UN-flipped
 *  workspace would misclassify an ordinary `((definitionId))` reference as
 *  machinery and silently drop a real backlink.
 *
 *  The `up` walk carries the same per-seed `path` visited-guard as
 *  `manyAncestorsSql` (treeQueries.ts) — issue #404 item 8b: without it a
 *  cyclic `parent_id` chain (issue #183) still terminates on `depth < 100`,
 *  but re-emits every cycle member on each loop iteration instead of
 *  stopping the moment a walk revisits a row it's already seen. */
export const propertyMachinerySourceIds = async (
  db: { getAll<T>(sql: string, params?: unknown[]): Promise<T[]> },
  sourceIds: readonly string[],
  chunkSize: number = MACHINERY_SOURCE_CHUNK,
): Promise<Set<string>> => {
  const machinery = new Set<string>()
  for (let i = 0; i < sourceIds.length; i += chunkSize) {
    const chunk = sourceIds.slice(i, i + chunkSize)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = await db.getAll<{ id: string }>(
      `WITH RECURSIVE up(start_id, id, reference_target_id, parent_id, workspace_id, path, depth) AS (
         SELECT id, id, reference_target_id, parent_id, workspace_id,
                '!' || hex(id) || '/',
                0
           FROM blocks WHERE id IN (${placeholders})
         UNION ALL
         SELECT up.start_id, b.id, b.reference_target_id, b.parent_id, b.workspace_id,
                up.path || '!' || hex(b.id) || '/',
                up.depth + 1
           FROM blocks AS b JOIN up ON b.id = up.parent_id
          WHERE up.depth < 100
            AND INSTR(up.path, '!' || hex(b.id) || '/') = 0
       )
       SELECT DISTINCT up.start_id AS id
         FROM up
        WHERE up.depth > 0
          AND up.reference_target_id IS NOT NULL
          AND up.parent_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM block_types bt
             WHERE bt.block_id = up.reference_target_id
               AND bt.type = 'property-schema'
               AND bt.workspace_id = up.workspace_id
          )`,
      [...chunk],
    )
    for (const r of rows) machinery.add(r.id)
  }
  return machinery
}

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
    // attribute one copy to invisible machinery. `true` returns EVERY source
    // (the raw `block_references` view), for inspection / debugging. Reference
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
    const ids = (await ctx.run('core.typedBlockIds', {
      workspaceId,
      referencedBy: {id},
      match: normalized.include,
      exclude: normalized.exclude,
      order: 'created-desc',
    })).filter(sourceId => sourceId !== id)
    // Machinery-source exclusion is flip-gated: an un-flipped workspace (all of
    // prod) has no property value children, so there is nothing to exclude and
    // this pays only the cached flip read.
    if (rawSources || ids.length === 0) return ids
    if (!(await readIsChildBackedWorkspace(ctx.db, workspaceId))) return ids
    const machinery = await propertyMachinerySourceIds(ctx.db, ids)
    return machinery.size === 0 ? ids : ids.filter(sourceId => !machinery.has(sourceId))
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [BACKLINKS_FOR_BLOCK_QUERY]: typeof backlinksForBlockQuery
  }
}
