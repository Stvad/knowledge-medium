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
import { recognizedFieldRowSql } from '@/data/internals/treeQueries'
import { registrySeedParams } from '@/data/internals/kernelQueries'

export const BACKLINKS_FOR_BLOCK_QUERY = 'backlinks.forBlock'

/** The seed `IN (?, …)` list binds one variable per source id, so a heavily
 *  backlinked block must be chunked under SQLite's `SQLITE_MAX_VARIABLE_NUMBER`
 *  (999 on older builds, 32766 since 3.32) — the same discipline the sync
 *  observer's staging reads use (`materialize.ts`). 500 keeps a wide margin. */
const MACHINERY_SOURCE_CHUNK = 500

/** Does this workspace hold ANY property machinery at all?
 *
 *  Data-keyed, not flip-gated — it asks about the rows that exist, so a
 *  backfilled pre-flip workspace answers yes and a flipped one that has never
 *  been backfilled answers no. One indexed probe (`idx_blocks_any_field_form`).
 *
 *  TOMBSTONES COUNT, which is why it is not the live `idx_blocks_field_form`.
 *  Recognition never filters `deleted` — descent is structural, and sync-apply
 *  permits a live child under a tombstoned parent — so a value row whose only
 *  field ancestor is tombstoned IS machinery to the walk. Probing live rows
 *  only would answer "nothing here" for that workspace and skip the filter
 *  over the very rows it exists to catch. A fast path must never be able to
 *  say no where the slow path would have said yes.
 *
 *  Its job is to keep the machinery filters from doing work that provably
 *  finds nothing: the ancestor walk below, and — the expensive one — the
 *  inline badge's whole id-list resolve. On a graph with no field rows both
 *  are guaranteed-empty, and every outline render was paying for them.
 *
 *  STALENESS: like the filters themselves this declares no dependency, so a
 *  mounted view can hold the fast path past the moment a workspace first grows
 *  machinery (km-z2bk). That moment is a backfill writing hundreds of
 *  thousands of rows, whose invalidation traffic no mounted view outlives —
 *  and it is the same dependency gap the filters already have, not a new one.
 */
export const workspaceHasPropertyMachinery = async (
  db: { getOptional<T>(sql: string, params?: unknown[]): Promise<T | null> },
  workspaceId: string,
): Promise<boolean> => (await db.getOptional(
  `SELECT 1 AS one FROM blocks
    WHERE workspace_id = ? AND is_field_form = 1 LIMIT 1`,
  [workspaceId],
)) !== null

/** Which of `sourceIds` are property-subtree INTERIOR machinery — a value child,
 *  or a row deeper inside a property subtree, whose parent chain passes through
 *  a §9 field row. Recognition IS `recognizedFieldRowSql`, shared with the
 *  outline rather than restated: the walk hoists the four columns the fragment
 *  reads under the names it expects, so parity is structural. Do not inline a
 *  copy here — the two predicates disagreeing is silent in both directions,
 *  dropping real backlinks or leaking duplicate ones.
 *
 *  Bind `[...sourceIdChunk, seedDefinitionIdsJson, seedWorkspaceId]`: the
 *  fragment's two parameters sit textually after the chunk placeholders.
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
 *  NOT flip-gated, and callers must not gate it either. `reference_target_id`
 *  derivation and `property-schema` types both exist independent of the flip,
 *  and so — since the cell→children backfill — do the field and value rows
 *  themselves. The `::` bit is what disambiguates machinery from an ordinary
 *  `((definitionId))` reference; the flip column never did, it only deferred
 *  the question to a moment when field rows were known to exist.
 *
 *  The `up` walk carries the same per-seed `path` visited-guard as
 *  `manyAncestorsSql` (treeQueries.ts) — issue #404 item 8b: without it a
 *  cyclic `parent_id` chain (issue #183) still terminates on `depth < 100`,
 *  but re-emits every cycle member on each loop iteration instead of
 *  stopping the moment a walk revisits a row it's already seen. */
export const propertyMachinerySourceIds = async (
  db: { getAll<T>(sql: string, params?: unknown[]): Promise<T[]> },
  sourceIds: readonly string[],
  seedParams: readonly [string, string],
  chunkSize: number = MACHINERY_SOURCE_CHUNK,
): Promise<Set<string>> => {
  const machinery = new Set<string>()
  for (let i = 0; i < sourceIds.length; i += chunkSize) {
    const chunk = sourceIds.slice(i, i + chunkSize)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = await db.getAll<{ id: string }>(
      `WITH RECURSIVE up(start_id, id, reference_target_id, is_field_form, parent_id, workspace_id, path, depth) AS (
         SELECT id, id, reference_target_id, is_field_form, parent_id, workspace_id,
                '!' || hex(id) || '/',
                0
           FROM blocks WHERE id IN (${placeholders})
         UNION ALL
         SELECT up.start_id, b.id, b.reference_target_id, b.is_field_form, b.parent_id, b.workspace_id,
                up.path || '!' || hex(b.id) || '/',
                up.depth + 1
           FROM blocks AS b JOIN up ON b.id = up.parent_id
          WHERE up.depth < 100
            AND INSTR(up.path, '!' || hex(b.id) || '/') = 0
       )
       SELECT DISTINCT up.start_id AS id
         FROM up
        WHERE up.depth > 0
          AND (${recognizedFieldRowSql('up')})`,
      [...chunk, ...seedParams],
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
    // NOT flip-gated. The gate's premise — an un-flipped workspace has no
    // property value children — is what the cell→children backfill breaks: it
    // mints them while the workspace still reads cells, and a ref-typed value
    // row's `[[X]]` then duplicates the owner's projected property edge on a
    // surface that had stopped filtering.
    //
    // KNOWN, pre-existing: this post-filter walks each SOURCE's ancestry, but
    // the only structural dep declared above is the TARGET's. Moving a source
    // out from under a field row — or editing an ancestor between `((D))` and
    // `::((D))` — changes membership with nothing to invalidate on, so the
    // list stays stale until the next reference change or a reload. Un-gating
    // makes it reachable in every workspace rather than only flipped ones.
    // Not fixed here: the honest fix is a dep per candidate source and walked
    // ancestor, and this query is composed by the inline badge on every
    // visible block. km-nc46.
    if (rawSources || ids.length === 0) return ids
    if (!(await workspaceHasPropertyMachinery(ctx.db, workspaceId))) return ids
    const machinery = await propertyMachinerySourceIds(ctx.db, ids, registrySeedParams(ctx.repo))
    return machinery.size === 0 ? ids : ids.filter(sourceId => !machinery.has(sourceId))
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [BACKLINKS_FOR_BLOCK_QUERY]: typeof backlinksForBlockQuery
  }
}
