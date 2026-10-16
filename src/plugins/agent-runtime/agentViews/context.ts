import type { Repo } from '@/data/repo'
import type { BlockData } from '@/data/api'
import { parseBlockRow, type BlockRow } from '@/data/blockSchema.js'
import { recognizedFieldRowSql } from '@/data/internals/treeQueries.js'
import { registryRecognitionParams } from '@/data/internals/kernelQueries.js'
import { aliasesProp } from '@/data/properties.js'
import { crumbsFromAncestors, type CrumbAncestor } from '@/utils/blockCrumbs.js'
import { textHeadSql } from './text.ts'
import { propertyNameResolverFor } from '@/utils/propertyValueContext.js'

/** Cost rule for every view: a block the view SHOWS is read whole, as the app
 *  reads it to render — the bound is on how many rows, not how big each is.
 *  What a view only quotes (crumbs, context lines, candidates) or counts is
 *  read bounded in SQL (`textHeadSql`, an aggregate), never as whole rows.
 *
 *  Live rows for `ids`, in input order; missing or deleted ids are skipped,
 *  and with `workspaceId` so is a row in another workspace — ids a
 *  workspace-filtered query returned can leave it before they are read, as
 *  sync rewrites `workspace_id` in place. */
export const loadBlocks = async (
  repo: Repo,
  ids: readonly string[],
  {workspaceId}: {workspaceId?: string} = {},
): Promise<BlockData[]> => {
  if (ids.length === 0) return []
  const rows = await repo.db.getAll<BlockRow>(
    `SELECT b.* FROM json_each(?) j JOIN blocks b ON b.id = j.value
      WHERE b.deleted = 0${workspaceId === undefined ? '' : ' AND b.workspace_id = ?'} ORDER BY j.key`,
    workspaceId === undefined ? [JSON.stringify(ids)] : [JSON.stringify(ids), workspaceId],
  )
  return rows.map(parseBlockRow)
}

/** Each start's ancestor ids, root-most last, with each row's parent edge:
 *  the walk `core.ancestors` makes (live rows, depth < 100, cycle-safe), over
 *  ids alone. */
const ANCESTOR_IDS_SQL = `
  WITH RECURSIVE chain(start_id, id, parent_id, path, depth) AS (
    SELECT b.id, b.id, b.parent_id, '!' || hex(b.id) || '/', 0
      FROM json_each(?) j JOIN blocks b ON b.id = j.value
     WHERE b.deleted = 0
    UNION ALL
    SELECT chain.start_id, p.id, p.parent_id, chain.path || '!' || hex(p.id) || '/', chain.depth + 1
      FROM chain JOIN blocks p ON p.id = chain.parent_id
     WHERE p.deleted = 0 AND chain.depth < 100
       AND INSTR(chain.path, '!' || hex(p.id) || '/') = 0
  )
  SELECT start_id, id, parent_id, depth FROM chain ORDER BY start_id, depth
`

/** How much of an ancestor's content and first alias a crumb reads; it shows
 *  24 characters. A cost bound: an ancestor shared by every hit is read once
 *  and cut, never hydrated whole. Accepted: an alias longer than this is
 *  ellipsized from the middle of its cut, not of the whole. */
const CRUMB_SOURCE_CHARS = 200

const CRUMB_ROWS_SQL = `
  SELECT b.id AS id, b.parent_id AS parent_id, b.workspace_id AS workspace_id,
         b.is_field_form AS is_field_form, b.reference_target_id AS reference_target_id,
         ${textHeadSql('b.content', CRUMB_SOURCE_CHARS)} AS content,
         CASE WHEN json_type(b.properties_json, '$.alias') = 'array' THEN (
           SELECT substr(a.value, 1, ${CRUMB_SOURCE_CHARS}) FROM json_each(b.properties_json, '$.alias') a
            WHERE a.type = 'text' AND trim(a.value) != '' LIMIT 1
         ) END AS alias
    FROM json_each(?) j JOIN blocks b ON b.id = j.value
   WHERE b.deleted = 0
`

interface CrumbRow {
  id: string
  parent_id: string | null
  workspace_id: string
  is_field_form: number | null
  reference_target_id: string | null
  content: string | null
  alias: string | null
}

const toCrumbAncestor = (row: CrumbRow): CrumbAncestor => ({
  workspaceId: row.workspace_id,
  parentId: row.parent_id,
  isFieldForm: row.is_field_form === 1,
  referenceTargetId: row.reference_target_id,
  content: row.content ?? '',
  properties: row.alias === null ? {} : {[aliasesProp.name]: [row.alias]},
})

/** Root→parent crumb labels per block (the panel's own formatter: aliases
 *  over content, field rows named by their property, a leading `…` where the
 *  chain is cut). Reads each distinct ancestor once, as a bounded projection. */
export const loadCrumbs = async (
  repo: Repo,
  ids: readonly string[],
  workspaceId: string,
): Promise<Map<string, string[]>> => {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const steps = await repo.db.getAll<{start_id: string, id: string, parent_id: string | null, depth: number}>(
    ANCESTOR_IDS_SQL,
    [JSON.stringify(unique)],
  )
  const ancestorIds = [...new Set(steps.filter(step => step.depth > 0).map(step => step.id))]
  const rows = ancestorIds.length === 0
    ? []
    : await repo.db.getAll<CrumbRow>(CRUMB_ROWS_SQL, [JSON.stringify(ancestorIds)])
  const ancestorById = new Map(rows.map(row => [row.id, toCrumbAncestor(row)]))

  // Rows come depth-ascending per start, so the last one's parent edge is
  // where the walk stopped: null when it reached a root. An ancestor that is
  // gone by the second read (sync deleted it meanwhile) cuts the walk there.
  const walks = new Map<string, {chain: CrumbAncestor[], stoppedAtParentId: string | null, cut: boolean}>()
  for (const step of steps) {
    const walk = walks.get(step.start_id) ?? {chain: [], stoppedAtParentId: null, cut: false}
    walks.set(step.start_id, walk)
    if (walk.cut) continue
    if (step.depth > 0) {
      const ancestor = ancestorById.get(step.id)
      if (!ancestor) {
        walk.cut = true
        walk.stoppedAtParentId = step.id
        continue
      }
      walk.chain.push(ancestor)
    }
    walk.stoppedAtParentId = step.parent_id
  }
  const propertyName = propertyNameResolverFor(repo, workspaceId)
  return new Map(unique.map(id => {
    const walk = walks.get(id) ?? {chain: [], stoppedAtParentId: null}
    return [id, crumbsFromAncestors(walk.chain, {workspaceId, stoppedAtParentId: walk.stoppedAtParentId, propertyName})]
  }))
}

/** `childRef` is a child an outline shows of the block whose id is
 *  `parentIdSql`: live, not a property field row, in the viewed workspace,
 *  and not the parent itself — sync applies parent ids verbatim, so a block
 *  can be its own parent or have one in another workspace, and rewrites
 *  `workspace_id` in place, so the view's workspace is bound rather than read
 *  off the parent mid-view. The one definition every child listing and count
 *  here uses. Binds {@link visibleChildParams}. */
const visibleChildOfSql = (childRef: string, parentIdSql: string): string => `
  ${childRef}.parent_id = ${parentIdSql} AND ${childRef}.id != ${parentIdSql} AND ${childRef}.deleted = 0
  AND ${childRef}.workspace_id = ?
  AND NOT (${recognizedFieldRowSql(childRef)})
`

/** What one {@link visibleChildOfSql} binds, in order. */
const visibleChildParams = (repo: Repo, workspaceId: string): unknown[] =>
  [workspaceId, ...registryRecognitionParams(repo)]

/** Count of the children an outline shows; binds {@link visibleChildParams}. */
const visibleChildCountSql = (rowRef: string): string => `
  (SELECT count(*) FROM blocks vc WHERE ${visibleChildOfSql('vc', `${rowRef}.id`)})
`

export const visibleChildCounts = async (
  repo: Repo,
  ids: readonly string[],
  workspaceId: string,
): Promise<Map<string, number>> => {
  if (ids.length === 0) return new Map()
  const rows = await repo.db.getAll<{id: string, n: number}>(
    `SELECT b.id AS id, ${visibleChildCountSql('b')} AS n
       FROM json_each(?) j JOIN blocks b ON b.id = j.value`,
    [...visibleChildParams(repo, workspaceId), JSON.stringify(ids)],
  )
  return new Map(rows.map(row => [row.id, row.n]))
}

/** The visible children of `parentIds`, ordered by parent (in input order)
 *  then sibling order, each with its own visible child count — one level of
 *  an outline. `limit`/`offset` page across the whole level. */
export const visibleChildrenLevel = async (
  repo: Repo,
  parentIds: readonly string[],
  {workspaceId, limit, offset = 0}: {workspaceId: string, limit: number, offset?: number},
): Promise<Array<{block: BlockData, childCount: number}>> => {
  if (parentIds.length === 0 || limit <= 0) return []
  const child = visibleChildParams(repo, workspaceId)
  const rows = await repo.db.getAll<BlockRow & {child_count: number}>(
    `SELECT child.*, ${visibleChildCountSql('child')} AS child_count
       FROM json_each(?) j
       JOIN blocks child ON child.parent_id = j.value
      WHERE ${visibleChildOfSql('child', 'j.value')}
      ORDER BY j.key, child.order_key, child.id
      LIMIT ? OFFSET ?`,
    [...child, JSON.stringify(parentIds), ...child, limit, offset],
  )
  return rows.map(row => ({block: parseBlockRow(row), childCount: row.child_count}))
}

/** The first visible child of each block, for context on a block that is
 *  only a link (its notes usually sit underneath it). */
export const firstVisibleChildren = async (
  repo: Repo,
  ids: readonly string[],
  workspaceId: string,
  chars: number,
): Promise<Map<string, string>> => {
  if (ids.length === 0) return new Map()
  const rows = await repo.db.getAll<{parent_id: string, content: string | null}>(
    `SELECT j.value AS parent_id, ${textHeadSql('child.content', chars)} AS content FROM json_each(?) j
       JOIN blocks child ON child.id = (
         SELECT c.id FROM blocks c
          WHERE ${visibleChildOfSql('c', 'j.value')}
          ORDER BY c.order_key, c.id LIMIT 1
       )`,
    [JSON.stringify(ids), ...visibleChildParams(repo, workspaceId)],
  )
  return new Map(rows.map(row => [row.parent_id, row.content ?? '']))
}

/** A bounded head of each block's content, with its workspace: for context
 *  lines that quote a neighbour, which never need the whole row. */
export const loadContentHeads = async (
  repo: Repo,
  ids: readonly string[],
  chars: number,
): Promise<Map<string, {workspaceId: string, content: string}>> => {
  if (ids.length === 0) return new Map()
  const rows = await repo.db.getAll<{id: string, workspace_id: string, content: string | null}>(
    `SELECT b.id AS id, b.workspace_id AS workspace_id, ${textHeadSql('b.content', chars)} AS content
       FROM json_each(?) j JOIN blocks b ON b.id = j.value WHERE b.deleted = 0`,
    [JSON.stringify(ids)],
  )
  return new Map(rows.map(row => [row.id, {workspaceId: row.workspace_id, content: row.content ?? ''}]))
}
