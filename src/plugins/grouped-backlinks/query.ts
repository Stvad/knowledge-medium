import { z } from 'zod'
import { defineQuery, type Schema } from '@/data/api'
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

/** Materialize every (block_id, ancestor_id) pair the grouping CTE
 *  would visit, so the resolver can register row deps on every
 *  walked ancestor. Without these deps, an intermediate ancestor
 *  (one that isn't itself a group block) gaining or losing a
 *  reference wouldn't invalidate the grouped handle, leaving
 *  groupings stale. Same recursion shape as the grouping CTE — just
 *  emits the ids without the join to block_references. */
export const SELECT_GROUPED_BACKLINK_ANCESTOR_IDS_SQL = `
  WITH RECURSIVE
    ${SOURCE_IDS_CTE},
    walk(source_id, anc_id, anc_parent_id, depth, path) AS (
      SELECT s.id, b.id, b.parent_id, 0, '!' || hex(b.id) || '/'
      FROM source_ids s
      JOIN blocks b ON b.id = s.id
      WHERE b.deleted = 0
      UNION ALL
      SELECT
        walk.source_id,
        parent.id,
        parent.parent_id,
        walk.depth + 1,
        walk.path || '!' || hex(parent.id) || '/'
      FROM walk
      JOIN blocks parent ON parent.id = walk.anc_parent_id
      WHERE parent.deleted = 0
        AND walk.depth < 100
        AND INSTR(walk.path, '!' || hex(parent.id) || '/') = 0
    )
  SELECT DISTINCT anc_id FROM walk
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

    // Target row dep — mirrors the backlinks wrapper. Re-resolve if
    // the target row itself changes (e.g. soft-delete).
    ctx.depend({kind: 'row', id})

    // Inline-resolve the typed-blocks call so its deps (typed-blocks
    // reference channel, per-source row deps via hydrateBlocks, etc.)
    // register against THIS handle, not the sub-query's handle. A
    // `repo.query[BACKLINKS_FOR_BLOCK_QUERY](...).load()` would
    // execute correctly but leave the grouped handle without the
    // invalidation triggers that wake the backlinks handle.
    const sourceData = (await resolveTypedBlocks({
      workspaceId,
      referencedBy: {id},
      match: hasBacklinksFilter(normalizedFilter) ? normalizedFilter.include : undefined,
      exclude: hasBacklinksFilter(normalizedFilter) ? normalizedFilter.exclude : undefined,
      order: 'created-desc',
    }, ctx)).filter(r => r.id !== id)
    if (sourceData.length === 0) return {groups: [], total: 0}

    const sourceIds = sourceData.map(source => source.id)
    // One JSON-array bind for the source-ids CTE (vs one per id).
    // Avoids the SQLite parameter ceiling on heavily-linked targets.
    const sourceIdsJson = JSON.stringify(sourceIds)

    // Walk every ancestor of every source up-front so intermediate
    // ancestors (rows that aren't themselves emitted as groups, but
    // whose references shape what groups exist) wake the handle when
    // their refs / parent_id change. Without this, an intermediate
    // ancestor gaining a ref wouldn't invalidate this handle —
    // grouped output would go stale.
    const ancestorIdRows = await ctx.db.getAll<{anc_id: string}>(
      SELECT_GROUPED_BACKLINK_ANCESTOR_IDS_SQL,
      [sourceIdsJson],
    )
    for (const row of ancestorIdRows) {
      ctx.depend({kind: 'row', id: row.anc_id})
    }

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
    }
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [GROUPED_BACKLINKS_FOR_BLOCK_QUERY]: typeof groupedBacklinksForBlockQuery
  }
}
