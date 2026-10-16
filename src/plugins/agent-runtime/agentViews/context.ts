import type { Repo } from '@/data/repo'
import type { BlockData } from '@/data/api'
import { parseBlockRow, type BlockRow } from '@/data/blockSchema.js'
import { recognizedFieldRowSql } from '@/data/internals/treeQueries.js'
import { registryRecognitionParams } from '@/data/internals/kernelQueries.js'
import { crumbsFromAncestors } from '@/utils/blockCrumbs.js'
import { propertyNameResolverFor } from '@/utils/propertyValueContext.js'

/** Live rows for `ids`, in input order; missing or deleted ids are skipped. */
export const loadBlocks = async (repo: Repo, ids: readonly string[]): Promise<BlockData[]> => {
  if (ids.length === 0) return []
  const rows = await repo.db.getAll<BlockRow>(
    'SELECT b.* FROM json_each(?) j JOIN blocks b ON b.id = j.value WHERE b.deleted = 0 ORDER BY j.key',
    [JSON.stringify(ids)],
  )
  return rows.map(parseBlockRow)
}

/** Root→parent crumb labels per block (the panel's own formatter: aliases
 *  over content, field rows named by their property, a leading `…` where the
 *  chain is cut). Walks started together coalesce into one statement. */
export const loadCrumbs = async (
  repo: Repo,
  ids: readonly string[],
  workspaceId: string,
): Promise<Map<string, string[]>> => {
  const unique = [...new Set(ids)]
  const walks = await Promise.all(unique.map(id => repo.query.ancestors({id}).load()))
  const propertyName = propertyNameResolverFor(repo, workspaceId)
  return new Map(unique.map((id, index) => [
    id,
    crumbsFromAncestors(walks[index].ancestors, {
      workspaceId,
      stoppedAtParentId: walks[index].stoppedAtParentId,
      propertyName,
    }),
  ]))
}

/** Count of the children an outline shows (property field rows excluded),
 *  bound as `[...RecognitionParams]` after the row reference's own params. */
const visibleChildCountSql = (rowRef: string): string => `
  (SELECT count(*) FROM blocks vc
    WHERE vc.parent_id = ${rowRef}.id AND vc.deleted = 0
      AND NOT (${recognizedFieldRowSql('vc')}))
`

export const visibleChildCounts = async (
  repo: Repo,
  ids: readonly string[],
): Promise<Map<string, number>> => {
  if (ids.length === 0) return new Map()
  const rows = await repo.db.getAll<{id: string, n: number}>(
    `SELECT b.id AS id, ${visibleChildCountSql('b')} AS n
       FROM json_each(?) j JOIN blocks b ON b.id = j.value`,
    [...registryRecognitionParams(repo), JSON.stringify(ids)],
  )
  return new Map(rows.map(row => [row.id, row.n]))
}

/** The visible children of `parentIds`, ordered by parent (in input order)
 *  then sibling order, each with its own visible child count — one level of
 *  an outline. `limit`/`offset` page across the whole level. */
export const visibleChildrenLevel = async (
  repo: Repo,
  parentIds: readonly string[],
  {limit, offset = 0}: {limit: number, offset?: number},
): Promise<Array<{block: BlockData, childCount: number}>> => {
  if (parentIds.length === 0 || limit <= 0) return []
  const recognition = registryRecognitionParams(repo)
  const rows = await repo.db.getAll<BlockRow & {child_count: number}>(
    `SELECT child.*, ${visibleChildCountSql('child')} AS child_count
       FROM json_each(?) j
       JOIN blocks child ON child.parent_id = j.value
      WHERE child.deleted = 0
        AND NOT (${recognizedFieldRowSql('child')})
      ORDER BY j.key, child.order_key, child.id
      LIMIT ? OFFSET ?`,
    [...recognition, JSON.stringify(parentIds), ...recognition, limit, offset],
  )
  return rows.map(row => ({block: parseBlockRow(row), childCount: row.child_count}))
}

/** The first visible child of each block, for context on a block that is
 *  only a link (its notes usually sit underneath it). */
export const firstVisibleChildren = async (
  repo: Repo,
  ids: readonly string[],
): Promise<Map<string, BlockData>> => {
  if (ids.length === 0) return new Map()
  const recognition = registryRecognitionParams(repo)
  const rows = await repo.db.getAll<BlockRow>(
    `SELECT child.* FROM json_each(?) j
       JOIN blocks child ON child.id = (
         SELECT c.id FROM blocks c
          WHERE c.parent_id = j.value AND c.deleted = 0
            AND NOT (${recognizedFieldRowSql('c')})
          ORDER BY c.order_key, c.id LIMIT 1
       )`,
    [JSON.stringify(ids), ...recognition],
  )
  return new Map(rows.map(row => {
    const block = parseBlockRow(row)
    return [block.parentId ?? '', block]
  }))
}

export const backlinkCount = async (repo: Repo, workspaceId: string, id: string): Promise<number> => {
  const [row] = await repo.db.getAll<{n: number}>(
    `SELECT count(DISTINCT source_id) AS n FROM block_references
      WHERE workspace_id = ? AND target_id = ? AND source_id != target_id`,
    [workspaceId, id],
  )
  return row?.n ?? 0
}
