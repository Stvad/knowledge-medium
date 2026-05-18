import { z } from 'zod'
import { defineQuery, type BlockData, type QueryCtx, type Schema } from '@/data/api'
import {
  buildQualifiedBlockColumnsSql,
  type BlockRow,
} from '@/data/blockSchema'
import { labelForBlockData } from '@/utils/linkTargetAutocomplete.ts'
import {
  hasBacklinksFilter,
  normalizeBacklinksFilter,
  type BacklinksFilter,
} from '@/plugins/backlinks/query.ts'
import { resolveTypedBlocks } from '@/data/internals/kernelQueries.ts'
import { manyAncestorsSql } from '@/data/internals/treeQueries.ts'
import {
  buildGroupedBacklinks,
  type GroupedBacklinkCandidate,
  type GroupedBacklinkGroup,
} from './grouping.ts'
import {
  EMPTY_GROUPED_BACKLINKS_CONFIG,
  normalizeGroupedBacklinksConfig,
  type GroupedBacklinksConfig,
} from './config.ts'

export const GROUPED_BACKLINKS_FOR_BLOCK_QUERY = 'groupedBacklinks.forBlock'

export interface GroupedBacklinkSourceParents {
  sourceId: string
  parents: BlockData[]
}

export interface GroupedBacklinksResult {
  groups: GroupedBacklinkGroup[]
  total: number
  unfilteredSources: BlockData[]
  sourceParents: GroupedBacklinkSourceParents[]
}

type CandidateRow = BlockRow & {
  source_id: string
  context_kind: 'ref' | 'root'
}

interface FieldCandidateRow {
  source_id: string
  source_field: string
}

const groupedBacklinksSchema: Schema<GroupedBacklinksResult> = {
  parse: (input) => input as GroupedBacklinksResult,
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

const groupedBacklinksConfigSchema = z.object({
  highPriorityTags: z.array(z.string()).optional(),
  lowPriorityTags: z.array(z.string()).optional(),
  excludedTags: z.array(z.string()).optional(),
  excludedPatterns: z.array(z.string()).optional(),
}).optional()

const asBlockRows = (rows: ReadonlyArray<BlockRow>): ReadonlyArray<Record<string, unknown>> =>
  rows as unknown as ReadonlyArray<Record<string, unknown>>

const resolveBacklinkSources = async (
  ctx: QueryCtx,
  workspaceId: string,
  id: string,
  filter?: Required<BacklinksFilter>,
): Promise<BlockData[]> =>
  (await resolveTypedBlocks({
    workspaceId,
    referencedBy: {id},
    match: filter?.include,
    exclude: filter?.exclude,
    order: 'created-desc',
  }, ctx)).filter(row => row.id !== id)

const resolveSourceParents = async (
  ctx: QueryCtx,
  sourceIds: readonly string[],
): Promise<GroupedBacklinkSourceParents[]> => {
  if (sourceIds.length === 0) return []

  type AncestorRow = BlockRow & {chain_start_id: string}
  const rows = await ctx.db.getAll<AncestorRow>(manyAncestorsSql(sourceIds.length), [...sourceIds])
  const rowsBySourceId = new Map<string, BlockRow[]>()
  for (const id of sourceIds) rowsBySourceId.set(id, [])
  for (const row of rows) {
    rowsBySourceId.get(row.chain_start_id)?.push(row)
  }

  return sourceIds.map(sourceId => ({
    sourceId,
    parents: ctx.hydrateBlocks(asBlockRows(rowsBySourceId.get(sourceId) ?? [])).reverse(),
  }))
}

/** Source ids ride in a single JSON-array bind parameter and unpack
 *  via `json_each`. One bind regardless of source count — avoids
 *  the SQLite parameter ceiling that would have been hit by a
 *  per-id `VALUES (?)` list on heavily-linked targets. */
const SOURCE_IDS_CTE = `source_ids(id) AS (SELECT value FROM json_each(?))`

/** Group context = (refs from source + each ancestor) UNION (root
 *  ancestor's own id). Roam-style: "what context is each backlink
 *  in?" — the page it lives on plus any tags/refs anywhere up the
 *  chain. Source ids come pre-filtered from the backlinks wrapper
 *  (which delegates to typed-blocks predicates), so this SQL is now
 *  filter-free and just walks ancestors for the given source set. */
export const SELECT_GROUPED_BACKLINK_CANDIDATES_SQL = `
  WITH RECURSIVE
    ${SOURCE_IDS_CTE},
    ancestor_chain(source_id, anc_id, anc_parent_id, depth, path) AS (
      SELECT s.id, b.id, b.parent_id, 0, '!' || hex(b.id) || '/'
      FROM source_ids s
      JOIN blocks b ON b.id = s.id
      WHERE b.deleted = 0
      UNION ALL
      SELECT
        ancestor_chain.source_id,
        parent.id,
        parent.parent_id,
        ancestor_chain.depth + 1,
        ancestor_chain.path || '!' || hex(parent.id) || '/'
      FROM ancestor_chain
      JOIN blocks parent ON parent.id = ancestor_chain.anc_parent_id
      WHERE parent.deleted = 0
        AND ancestor_chain.depth < 100
        AND INSTR(ancestor_chain.path, '!' || hex(parent.id) || '/') = 0
    ),
    group_context_refs AS (
      SELECT DISTINCT
        ancestor_chain.source_id,
        refs.target_id AS context_id,
        'ref' AS context_kind
      FROM ancestor_chain
      JOIN block_references refs ON refs.source_id = ancestor_chain.anc_id
      WHERE refs.workspace_id = ?
        AND (refs.source_field = '' OR refs.target_id != ?)
      UNION
      SELECT
        ancestor_chain.source_id,
        ancestor_chain.anc_id AS context_id,
        'root' AS context_kind
      FROM ancestor_chain
      WHERE ancestor_chain.anc_parent_id IS NULL
    )
  SELECT DISTINCT
    cr.source_id AS source_id,
    cr.context_kind AS context_kind,
    ${buildQualifiedBlockColumnsSql('group_block')}
  FROM group_context_refs cr
  JOIN blocks group_block ON group_block.id = cr.context_id
  WHERE group_block.deleted = 0
  ORDER BY cr.source_id, group_block.updated_at DESC, group_block.id
`

export const SELECT_GROUPED_BACKLINK_FIELD_CANDIDATES_SQL = `
  WITH ${SOURCE_IDS_CTE}
  SELECT DISTINCT
    refs.source_id AS source_id,
    refs.source_field AS source_field
  FROM source_ids s
  JOIN block_references refs ON refs.source_id = s.id
  WHERE refs.workspace_id = ?
    AND refs.target_id = ?
    AND refs.source_field != ''
  ORDER BY refs.source_id, refs.source_field
`

export const groupedBacklinksForBlockQuery = defineQuery<
  {
    workspaceId: string
    id: string
    filter?: BacklinksFilter
    groupingConfig?: Partial<GroupedBacklinksConfig>
  },
  GroupedBacklinksResult
>({
  name: GROUPED_BACKLINKS_FOR_BLOCK_QUERY,
  argsSchema: z.object({
    workspaceId: z.string(),
    id: z.string(),
    filter: backlinksFilterSchema,
    groupingConfig: groupedBacklinksConfigSchema,
  }),
  resultSchema: groupedBacklinksSchema,
  resolve: async ({workspaceId, id, filter, groupingConfig}, ctx) => {
    if (!workspaceId || !id) {
      return {groups: [], total: 0, unfilteredSources: [], sourceParents: []}
    }

    const normalizedFilter = normalizeBacklinksFilter(filter)
    const normalizedGroupingConfig = normalizeGroupedBacklinksConfig(
      groupingConfig ?? EMPTY_GROUPED_BACKLINKS_CONFIG,
    )

    // Target row dep — mirrors the backlinks wrapper. Re-resolve if
    // the target row itself changes (e.g. soft-delete).
    ctx.depend({kind: 'row', id})

    // Inline-resolve the typed-blocks calls so their deps (typed-blocks
    // reference channel, per-source row deps via hydrateBlocks, etc.)
    // register against THIS handle, not the sub-query's handle. A
    // `repo.query[BACKLINKS_FOR_BLOCK_QUERY](...).load()` would
    // execute correctly but leave the grouped handle without the
    // invalidation triggers that wake the backlinks handle.
    const unfilteredSources = await resolveBacklinkSources(ctx, workspaceId, id)
    const sourceData = hasBacklinksFilter(normalizedFilter)
      ? await resolveBacklinkSources(ctx, workspaceId, id, normalizedFilter)
      : unfilteredSources
    if (sourceData.length === 0) {
      return {groups: [], total: 0, unfilteredSources, sourceParents: []}
    }

    const sourceIds = sourceData.map(source => source.id)
    const sourceParents = await resolveSourceParents(ctx, sourceIds)
    // One JSON-array bind for the source-ids CTE (vs one per id).
    // Avoids the SQLite parameter ceiling on heavily-linked targets.
    const sourceIdsJson = JSON.stringify(sourceIds)

    // `sourceParents` is part of the result now, so hydrating those
    // rows also declares deps for every ancestor that can affect
    // grouping. The source rows themselves were hydrated by
    // `resolveTypedBlocks`.

    const candidateRows = await ctx.db.getAll<CandidateRow>(
      SELECT_GROUPED_BACKLINK_CANDIDATES_SQL,
      [sourceIdsJson, workspaceId, id],
    )
    const fieldCandidateRows = await ctx.db.getAll<FieldCandidateRow>(
      SELECT_GROUPED_BACKLINK_FIELD_CANDIDATES_SQL,
      [sourceIdsJson, workspaceId, id],
    )

    const groupRowsById = new Map<string, BlockRow>()
    for (const row of candidateRows) {
      groupRowsById.set(row.id, row)
    }
    const groupData = ctx.hydrateBlocks(asBlockRows(Array.from(groupRowsById.values())))
    const labelByGroupId = new Map(groupData.map(data => [data.id, labelForBlockData(data, data.id)]))

    const candidates: GroupedBacklinkCandidate[] = candidateRows.map(row => ({
      sourceId: row.source_id,
      groupId: row.id,
      groupLabel: labelByGroupId.get(row.id) ?? (row.content.trim() || row.id),
      kind: row.context_kind === 'root' ? 'root' : 'ref',
    }))
    for (const row of fieldCandidateRows) {
      candidates.push({
        sourceId: row.source_id,
        groupId: `field:${row.source_field}`,
        groupLabel: row.source_field,
        kind: 'field',
      })
    }

    return {
      groups: buildGroupedBacklinks({
        targetId: id,
        sourceOrder: sourceIds,
        candidates,
        groupingConfig: normalizedGroupingConfig,
      }),
      total: sourceData.length,
      unfilteredSources,
      sourceParents,
    }
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [GROUPED_BACKLINKS_FOR_BLOCK_QUERY]: typeof groupedBacklinksForBlockQuery
  }
}
