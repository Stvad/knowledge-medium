import { z } from 'zod'
import { defineQuery, type Schema } from '@/data/api'
import {
  buildQualifiedBlockColumnsSql,
  type BlockRow,
} from '@/data/blockSchema'
import { labelForBlockData } from '@/utils/linkTargetAutocomplete.ts'
import {
  BACKLINKS_FOR_BLOCK_QUERY,
  normalizeBacklinksFilter,
  SELECT_FILTERED_BACKLINK_CONTEXT_NODE_IDS_SQL,
  type BacklinksFilter,
} from '@/plugins/backlinks/query.ts'
import { BACKLINKS_TARGET_INVALIDATION_CHANNEL } from '@/plugins/backlinks/invalidation.ts'
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

const backlinksFilterSchema = z.object({
  includeIds: z.array(z.string()).optional(),
  removeIds: z.array(z.string()).optional(),
}).optional()

const groupedBacklinksConfigSchema = z.object({
  highPriorityTags: z.array(z.string()).optional(),
  lowPriorityTags: z.array(z.string()).optional(),
  excludedTags: z.array(z.string()).optional(),
  excludedPatterns: z.array(z.string()).optional(),
}).optional()

const asBlockRows = (rows: ReadonlyArray<BlockRow>): ReadonlyArray<Record<string, unknown>> =>
  rows as unknown as ReadonlyArray<Record<string, unknown>>

const filterValuesCteSql = (name: string, count: number): string =>
  count === 0
    ? `${name}(id) AS (SELECT NULL WHERE 0)`
    : `${name}(id) AS (VALUES ${Array(count).fill('(?)').join(', ')})`

export const selectGroupedBacklinkCandidatesSql = (
  includeCount: number,
  removeCount: number,
): string => `
  WITH
    backlink_sources AS (
      SELECT DISTINCT br.source_id
      FROM block_references br
      JOIN blocks source ON source.id = br.source_id
      WHERE br.workspace_id = ?
        AND source.id != ?
        AND br.target_id = ?
        AND source.deleted = 0
    ),
    ${filterValuesCteSql('include_filter', includeCount)},
    ${filterValuesCteSql('remove_filter', removeCount)},
    ancestor_chain(source_id, id, parent_id, depth, path) AS (
      SELECT
        bs.source_id,
        source.id,
        source.parent_id,
        0,
        '!' || hex(source.id) || '/'
      FROM backlink_sources bs
      JOIN blocks source ON source.id = bs.source_id
      WHERE source.deleted = 0
      UNION ALL
      SELECT
        ancestor_chain.source_id,
        parent.id,
        parent.parent_id,
        ancestor_chain.depth + 1,
        ancestor_chain.path || '!' || hex(parent.id) || '/'
      FROM ancestor_chain
      JOIN blocks parent ON parent.id = ancestor_chain.parent_id
      WHERE parent.deleted = 0
        AND ancestor_chain.depth < 100
        AND INSTR(ancestor_chain.path, '!' || hex(parent.id) || '/') = 0
    ),
    filter_context_refs AS (
      SELECT DISTINCT
        ancestor_chain.source_id,
        refs.target_id AS context_id
      FROM ancestor_chain
      JOIN block_references refs ON refs.source_id = ancestor_chain.id
      WHERE refs.workspace_id = ?
      UNION
      SELECT
        ancestor_chain.source_id,
        ancestor_chain.id AS context_id
      FROM ancestor_chain
      WHERE ancestor_chain.parent_id IS NULL
    ),
    group_context_refs AS (
      SELECT DISTINCT
        ancestor_chain.source_id,
        refs.target_id AS context_id,
        'ref' AS context_kind
      FROM ancestor_chain
      JOIN block_references refs ON refs.source_id = ancestor_chain.id
      WHERE refs.workspace_id = ?
        AND (refs.source_field = '' OR refs.target_id != ?)
      UNION
      SELECT
        ancestor_chain.source_id,
        ancestor_chain.id AS context_id,
        'root' AS context_kind
      FROM ancestor_chain
      WHERE ancestor_chain.parent_id IS NULL
    ),
    filtered_sources AS (
      SELECT bs.source_id
      FROM backlink_sources bs
      WHERE NOT EXISTS (
          SELECT 1
          FROM include_filter required
          WHERE NOT EXISTS (
            SELECT 1
            FROM filter_context_refs cr
            WHERE cr.source_id = bs.source_id
              AND cr.context_id = required.id
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM filter_context_refs cr
          JOIN remove_filter removed ON removed.id = cr.context_id
          WHERE cr.source_id = bs.source_id
        )
    )
  SELECT DISTINCT
    cr.source_id AS source_id,
    cr.context_kind AS context_kind,
    ${buildQualifiedBlockColumnsSql('group_block')}
  FROM filtered_sources fs
  JOIN group_context_refs cr ON cr.source_id = fs.source_id
  JOIN blocks group_block ON group_block.id = cr.context_id
  WHERE group_block.deleted = 0
  ORDER BY cr.source_id, group_block.updated_at DESC, group_block.id
`

export const selectGroupedBacklinkFieldCandidatesSql = (
  includeCount: number,
  removeCount: number,
): string => `
  WITH
    backlink_sources AS (
      SELECT DISTINCT br.source_id
      FROM block_references br
      JOIN blocks source ON source.id = br.source_id
      WHERE br.workspace_id = ?
        AND source.id != ?
        AND br.target_id = ?
        AND source.deleted = 0
    ),
    ${filterValuesCteSql('include_filter', includeCount)},
    ${filterValuesCteSql('remove_filter', removeCount)},
    ancestor_chain(source_id, id, parent_id, depth, path) AS (
      SELECT
        bs.source_id,
        source.id,
        source.parent_id,
        0,
        '!' || hex(source.id) || '/'
      FROM backlink_sources bs
      JOIN blocks source ON source.id = bs.source_id
      WHERE source.deleted = 0
      UNION ALL
      SELECT
        ancestor_chain.source_id,
        parent.id,
        parent.parent_id,
        ancestor_chain.depth + 1,
        ancestor_chain.path || '!' || hex(parent.id) || '/'
      FROM ancestor_chain
      JOIN blocks parent ON parent.id = ancestor_chain.parent_id
      WHERE parent.deleted = 0
        AND ancestor_chain.depth < 100
        AND INSTR(ancestor_chain.path, '!' || hex(parent.id) || '/') = 0
    ),
    filter_context_refs AS (
      SELECT DISTINCT
        ancestor_chain.source_id,
        refs.target_id AS context_id
      FROM ancestor_chain
      JOIN block_references refs ON refs.source_id = ancestor_chain.id
      WHERE refs.workspace_id = ?
      UNION
      SELECT
        ancestor_chain.source_id,
        ancestor_chain.id AS context_id
      FROM ancestor_chain
      WHERE ancestor_chain.parent_id IS NULL
    ),
    filtered_sources AS (
      SELECT bs.source_id
      FROM backlink_sources bs
      WHERE NOT EXISTS (
          SELECT 1
          FROM include_filter required
          WHERE NOT EXISTS (
            SELECT 1
            FROM filter_context_refs cr
            WHERE cr.source_id = bs.source_id
              AND cr.context_id = required.id
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM filter_context_refs cr
          JOIN remove_filter removed ON removed.id = cr.context_id
          WHERE cr.source_id = bs.source_id
        )
    )
  SELECT DISTINCT
    fs.source_id AS source_id,
    refs.source_field AS source_field
  FROM filtered_sources fs
  JOIN block_references refs ON refs.source_id = fs.source_id
  WHERE refs.workspace_id = ?
    AND refs.target_id = ?
    AND refs.source_field != ''
  ORDER BY fs.source_id, refs.source_field
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
    ctx.depend({kind: 'row', id})
    if (!workspaceId || !id) return {groups: [], total: 0}
    ctx.depend({
      kind: 'plugin',
      channel: BACKLINKS_TARGET_INVALIDATION_CHANNEL,
      key: id,
    })

    const normalizedFilter = normalizeBacklinksFilter(filter)
    const normalizedGroupingConfig = normalizeGroupedBacklinksConfig(
      groupingConfig ?? EMPTY_GROUPED_BACKLINKS_CONFIG,
    )
    const filterActive = normalizedFilter.includeIds.length > 0 ||
      normalizedFilter.removeIds.length > 0
    const backlinkArgs = filterActive
      ? {workspaceId, id, filter: normalizedFilter}
      : {workspaceId, id}
    const sources = await ctx.repo.query[BACKLINKS_FOR_BLOCK_QUERY](backlinkArgs).load()
    if (sources.length === 0) return {groups: [], total: 0}

    const contextNodes = await ctx.db.getAll<{id: string}>(
      SELECT_FILTERED_BACKLINK_CONTEXT_NODE_IDS_SQL,
      [workspaceId, id, id],
    )
    for (const node of contextNodes) {
      ctx.depend({kind: 'row', id: node.id})
    }

    const candidateRows = await ctx.db.getAll<CandidateRow>(
      selectGroupedBacklinkCandidatesSql(
        normalizedFilter.includeIds.length,
        normalizedFilter.removeIds.length,
      ),
      [
        workspaceId,
        id,
        id,
        ...normalizedFilter.includeIds,
        ...normalizedFilter.removeIds,
        workspaceId,
        workspaceId,
        id,
      ],
    )
    const fieldCandidateRows = await ctx.db.getAll<FieldCandidateRow>(
      selectGroupedBacklinkFieldCandidatesSql(
        normalizedFilter.includeIds.length,
        normalizedFilter.removeIds.length,
      ),
      [
        workspaceId,
        id,
        id,
        ...normalizedFilter.includeIds,
        ...normalizedFilter.removeIds,
        workspaceId,
        workspaceId,
        id,
      ],
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
