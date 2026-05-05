import { z } from 'zod'
import { defineQuery, type BlockData, type Schema } from '@/data/api'
import {
  buildQualifiedBlockColumnsSql,
  type BlockRow,
} from '@/data/blockSchema'
import { BACKLINKS_TARGET_INVALIDATION_CHANNEL } from './invalidation.ts'

export const BACKLINKS_FOR_BLOCK_QUERY = 'backlinks.forBlock'

export interface BacklinksFilter {
  includeIds?: string[]
  removeIds?: string[]
}

const backlinksFilterSchema = z.object({
  includeIds: z.array(z.string()).optional(),
  removeIds: z.array(z.string()).optional(),
}).optional()

/** Backlinks: blocks whose `references_json` array contains an entry
 *  with `id = ?`. Reads through the trigger-maintained
 *  `block_references` edge index, then hydrates the source rows. */
export const SELECT_BACKLINKS_FOR_BLOCK_SQL = `
  SELECT DISTINCT ${buildQualifiedBlockColumnsSql('b')}
  FROM block_references br
  JOIN blocks b ON b.id = br.source_id
  WHERE br.workspace_id = ?
    AND b.id != ?
    AND br.target_id = ?
    AND b.deleted = 0
  ORDER BY b.created_at DESC, b.id
`

const filterValuesCteSql = (name: string, count: number): string =>
  count === 0
    ? `${name}(id) AS (SELECT NULL WHERE 0)`
    : `${name}(id) AS (VALUES ${Array(count).fill('(?)').join(', ')})`

export const selectFilteredBacklinksForBlockSql = (
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
    context_refs AS (
      SELECT DISTINCT ancestor_chain.source_id, refs.target_id AS context_id
      FROM ancestor_chain
      JOIN block_references refs ON refs.source_id = ancestor_chain.id
      WHERE refs.workspace_id = ?
      UNION
      SELECT ancestor_chain.source_id, ancestor_chain.id AS context_id
      FROM ancestor_chain
      WHERE ancestor_chain.parent_id IS NULL
    )
  SELECT DISTINCT ${buildQualifiedBlockColumnsSql('b')}
  FROM backlink_sources bs
  JOIN blocks b ON b.id = bs.source_id
  WHERE NOT EXISTS (
      SELECT 1
      FROM include_filter required
      WHERE NOT EXISTS (
        SELECT 1
        FROM context_refs cr
        WHERE cr.source_id = bs.source_id
          AND cr.context_id = required.id
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM context_refs cr
      JOIN remove_filter removed ON removed.id = cr.context_id
      WHERE cr.source_id = bs.source_id
    )
  ORDER BY b.created_at DESC, b.id
`

export const SELECT_FILTERED_BACKLINK_CONTEXT_NODE_IDS_SQL = `
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
    )
  SELECT DISTINCT id FROM ancestor_chain
`

const blockDataArraySchema: Schema<BlockData[]> = {
  parse: (input) => input as BlockData[],
}

const asBlockRows = (rows: ReadonlyArray<BlockRow>): ReadonlyArray<Record<string, unknown>> =>
  rows as unknown as ReadonlyArray<Record<string, unknown>>

const uniqueNonEmpty = (ids: readonly string[] | undefined): string[] =>
  Array.from(new Set((ids ?? []).map(id => id.trim()).filter(Boolean)))

export const normalizeBacklinksFilter = (
  filter: BacklinksFilter | undefined,
): Required<BacklinksFilter> => ({
  includeIds: uniqueNonEmpty(filter?.includeIds),
  removeIds: uniqueNonEmpty(filter?.removeIds),
})

export const hasBacklinksFilter = (filter: BacklinksFilter | undefined): boolean => {
  const normalized = normalizeBacklinksFilter(filter)
  return normalized.includeIds.length > 0 || normalized.removeIds.length > 0
}

/** Every block in `workspaceId` whose references point at `id`.
 *
 *  Dep declaration:
 *    - `{kind:'row', id}` for the target row.
 *    - plugin dep on `backlinks.target:${id}` for the precise incoming-edge set.
 *    - Per-source row deps from `hydrateBlocks`, so content edits on
 *      existing source rows update the rendered backlinks list. */
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
    ctx.depend({kind: 'row', id})
    if (!workspaceId || !id) return []
    ctx.depend({
      kind: 'plugin',
      channel: BACKLINKS_TARGET_INVALIDATION_CHANNEL,
      key: id,
    })
    const normalizedFilter = normalizeBacklinksFilter(filter)
    const filterActive = normalizedFilter.includeIds.length > 0 ||
      normalizedFilter.removeIds.length > 0
    if (filterActive) {
      const contextNodes = await ctx.db.getAll<{id: string}>(
        SELECT_FILTERED_BACKLINK_CONTEXT_NODE_IDS_SQL,
        [workspaceId, id, id],
      )
      for (const node of contextNodes) {
        ctx.depend({kind: 'row', id: node.id})
      }
      const rows = await ctx.db.getAll<BlockRow>(
        selectFilteredBacklinksForBlockSql(
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
        ],
      )
      return ctx.hydrateBlocks(asBlockRows(rows))
    }
    const rows = await ctx.db.getAll<BlockRow>(
      SELECT_BACKLINKS_FOR_BLOCK_SQL, [workspaceId, id, id],
    )
    return ctx.hydrateBlocks(asBlockRows(rows))
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [BACKLINKS_FOR_BLOCK_QUERY]: typeof backlinksForBlockQuery
  }
}
