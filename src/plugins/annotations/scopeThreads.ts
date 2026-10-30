import {z} from 'zod'
import {defineQuery, type Schema} from '@/data/api'
import {buildQualifiedBlockColumnsSql} from '@/data/blockSchema'
import {
  TYPED_BLOCKS_STRUCTURE_CHANNEL,
  TYPED_BLOCKS_TYPE_CHANNEL,
  typedBlocksStructureKey,
  typedBlocksTypeKey,
} from '@/data/invalidation'
import {hasBlockType} from '@/data/properties'
import {annotationTargetProp, THREAD_TYPE, threadIsOpen} from './schema.ts'

export const THREADS_IN_SCOPE_QUERY = 'annotations.threadsInScope'

export interface ScopeThread {
  threadId: string
  open: boolean
  /** The target and its ancestors, nearest first, up to but not including
   *  the scope root: empty for a thread on the scope root itself. */
  path: readonly string[]
}

/** Every thread root of the workspace with its target, walked UP from the
 *  target, one row per (thread, block on the way). The target's row is there
 *  even when it is missing or deleted (`live` = 0), so its restore can wake
 *  the query; the walk goes on only from live blocks, and stops at the scope
 *  root. Binds the edge's field name, the workspace, the thread type, then
 *  the scope root. */
const THREAD_PATHS_SQL = `
  WITH RECURSIVE
  roots(thread_id, target_id) AS (
    SELECT t.block_id, edge.target_id
      FROM block_types t
      JOIN blocks root ON root.id = t.block_id AND root.deleted = 0
      JOIN block_references edge ON edge.source_id = t.block_id AND edge.source_field = ?
     WHERE t.workspace_id = ? AND t.type = ?
  ),
  up(thread_id, id, parent_id, live, depth) AS (
    SELECT roots.thread_id, roots.target_id, b.parent_id, COALESCE(b.deleted = 0, 0), 0
      FROM roots LEFT JOIN blocks b ON b.id = roots.target_id
    UNION ALL
    SELECT up.thread_id, p.id, p.parent_id, 1, up.depth + 1
      FROM up JOIN blocks p ON p.id = up.parent_id
     WHERE up.live = 1 AND up.id != ? AND p.deleted = 0 AND up.depth < 100
  )
  SELECT thread_id, id, parent_id FROM up ORDER BY thread_id, depth
`

const SELECT_ROOTS_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql('b')}
    FROM json_each(?) j
    JOIN blocks b ON b.id = j.value
   WHERE b.deleted = 0
`

const scopeThreadsSchema: Schema<ScopeThread[]> = {parse: input => input as ScopeThread[]}

/** The threads anchored inside `scopeId`'s subtree (the scope root
 *  included), each with the path from its target up to the scope: what the
 *  margin needs to place a thread whose row is not rendered (collapsed, or
 *  not yet mounted) on its nearest rendered ancestor. Threads anchored to a
 *  comment are not in it: their path leads to the comments page.
 *
 *  Walks up from each thread's target, so it costs threads × depth rather
 *  than the size of the scope. Re-resolves on a thread created, deleted or
 *  restored (its type), on any root's own edit, in scope or not (its status,
 *  or a retarget), and on any block on a walked path moving, being deleted or
 *  restored (its structure key; the walk's last block's parent too, which may
 *  be restored). Editing the outline's text wakes nothing. */
export const threadsInScopeQuery = defineQuery<{workspaceId: string; scopeId: string}, ScopeThread[]>({
  name: THREADS_IN_SCOPE_QUERY,
  argsSchema: z.object({workspaceId: z.string(), scopeId: z.string()}),
  resultSchema: scopeThreadsSchema,
  resolve: async ({workspaceId, scopeId}, ctx) => {
    if (!workspaceId || !scopeId) return []
    ctx.depend({kind: 'plugin', channel: TYPED_BLOCKS_TYPE_CHANNEL, key: typedBlocksTypeKey(workspaceId, THREAD_TYPE)})
    const rows = await ctx.db.getAll<{thread_id: string; id: string; parent_id: string | null}>(
      THREAD_PATHS_SQL, [annotationTargetProp.name, workspaceId, THREAD_TYPE, scopeId],
    )
    const walks = new Map<string, Array<{id: string; parentId: string | null}>>()
    for (const row of rows) {
      const walk = walks.get(row.thread_id)
      const step = {id: row.id, parentId: row.parent_id}
      if (walk) walk.push(step)
      else walks.set(row.thread_id, [step])
    }
    const structure = (id: string) => ctx.depend({
      kind: 'plugin', channel: TYPED_BLOCKS_STRUCTURE_CHANNEL, key: typedBlocksStructureKey(workspaceId, id),
    })
    const paths = new Map<string, string[]>()
    for (const [threadId, walk] of walks) {
      // Every root, in scope or not: a retarget moves its edge only when the
      // references processor rewrites the root, after the property changed.
      ctx.depend({kind: 'row', id: threadId})
      for (const step of walk) structure(step.id)
      const last = walk[walk.length - 1]
      if (last.id === scopeId) paths.set(threadId, walk.slice(0, -1).map(step => step.id))
      else if (last.parentId) structure(last.parentId)
    }
    if (paths.size === 0) return []
    const roots = ctx.hydrateBlocks(
      await ctx.db.getAll<Record<string, unknown>>(SELECT_ROOTS_SQL, [JSON.stringify([...paths.keys()])]),
    )
    return roots
      .filter(root => hasBlockType(root, THREAD_TYPE))
      .map(root => ({threadId: root.id, open: threadIsOpen(root), path: paths.get(root.id)!}))
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [THREADS_IN_SCOPE_QUERY]: typeof threadsInScopeQuery
  }
}
