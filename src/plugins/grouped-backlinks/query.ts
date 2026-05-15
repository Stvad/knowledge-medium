import { z } from 'zod'
import { defineQuery, type Schema } from '@/data/api'
import {
  buildQualifiedBlockColumnsSql,
  type BlockRow,
} from '@/data/blockSchema'
import { labelForBlockData } from '@/utils/linkTargetAutocomplete.ts'
import {
  BACKLINKS_FOR_BLOCK_QUERY,
  hasBacklinksFilter,
  normalizeBacklinksFilter,
  type BacklinksFilter,
} from '@/plugins/backlinks/query.ts'
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

export interface GroupedBacklinksResult {
  groups: GroupedBacklinkGroup[]
  total: number
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

const sourceIdsCte = (count: number): string =>
  count === 0
    ? 'source_ids(id) AS (SELECT NULL WHERE 0)'
    : `source_ids(id) AS (VALUES ${Array(count).fill('(?)').join(', ')})`

/** Group context = (refs from source + each ancestor) UNION (root
 *  ancestor's own id). Roam-style: "what context is each backlink
 *  in?" — the page it lives on plus any tags/refs anywhere up the
 *  chain. Source ids come pre-filtered from the backlinks wrapper
 *  (which delegates to typed-blocks predicates), so this SQL is now
 *  filter-free and just walks ancestors for the given source set. */
export const selectGroupedBacklinkCandidatesSql = (sourceCount: number): string => `
  WITH RECURSIVE
    ${sourceIdsCte(sourceCount)},
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

export const selectGroupedBacklinkFieldCandidatesSql = (sourceCount: number): string => `
  WITH ${sourceIdsCte(sourceCount)}
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
    if (!workspaceId || !id) return {groups: [], total: 0}

    const normalizedFilter = normalizeBacklinksFilter(filter)
    const normalizedGroupingConfig = normalizeGroupedBacklinksConfig(
      groupingConfig ?? EMPTY_GROUPED_BACKLINKS_CONFIG,
    )
    const backlinkArgs = hasBacklinksFilter(normalizedFilter)
      ? {workspaceId, id, filter: normalizedFilter}
      : {workspaceId, id}
    // Forwards target row dep, typed-blocks reference channel dep,
    // and per-source row deps via the wrapper.
    const sources = await ctx.repo.query[BACKLINKS_FOR_BLOCK_QUERY](backlinkArgs).load()
    if (sources.length === 0) return {groups: [], total: 0}

    const sourceIds = sources.map(source => source.id)

    const candidateRows = await ctx.db.getAll<CandidateRow>(
      selectGroupedBacklinkCandidatesSql(sourceIds.length),
      [...sourceIds, workspaceId, id],
    )
    const fieldCandidateRows = await ctx.db.getAll<FieldCandidateRow>(
      selectGroupedBacklinkFieldCandidatesSql(sourceIds.length),
      [...sourceIds, workspaceId, id],
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
        sourceOrder: sources.map(source => source.id),
        candidates,
        groupingConfig: normalizedGroupingConfig,
      }),
      total: sources.length,
    }
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [GROUPED_BACKLINKS_FOR_BLOCK_QUERY]: typeof groupedBacklinksForBlockQuery
  }
}
