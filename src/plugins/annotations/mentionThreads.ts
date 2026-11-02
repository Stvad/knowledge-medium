import type {QueryCtx} from '@/data/api'
import {
  TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL,
  TYPED_BLOCKS_STRUCTURE_CHANNEL,
  TYPED_BLOCKS_TYPE_CHANNEL,
  typedBlocksReferenceFieldKey,
  typedBlocksStructureKey,
  typedBlocksTypeKey,
} from '@/data/invalidation'
import {ReadBatcher, readBatcherPerDb} from '@/data/internals/readBatch'
import {THREAD_IDS_FOR_BLOCK_QUERY} from './queries.ts'
import {annotationTargetProp, THREAD_TYPE} from './schema.ts'
import {threadCoverageCte} from './threadCoverage.ts'

// CROSS JOIN keeps the id list outermost without relying on table statistics.
export const THREAD_COMMENTS_SQL = `${threadCoverageCte(`
  SELECT j.value, root.id, root.id, root.workspace_id
    FROM json_each(?) j CROSS JOIN blocks root ON root.id = j.value
   WHERE root.deleted = 0 AND root.workspace_id = ?
     AND EXISTS (SELECT 1 FROM block_types t WHERE t.block_id = root.id AND t.type = '${THREAD_TYPE}')
`, () => '0')}
  SELECT start_id, id FROM covered
`

const batcherFor = readBatcherPerDb(db => new ReadBatcher<string, readonly string[]>(db, {
  read: async (workspaceId, roots) => {
    const rows = await db.getAll<{start_id: string; id: string}>(THREAD_COMMENTS_SQL, [JSON.stringify(roots), workspaceId])
    const answers = new Map<string, string[]>()
    for (const row of rows) {
      const ids = answers.get(row.start_id)
      if (ids) ids.push(row.id)
      else answers.set(row.start_id, [row.id])
    }
    return id => answers.get(id) ?? []
  },
}))

/** The small duplicate set grows down from the target's own threads, never
 *  up from its backlink sources. Field rows need no separate exclusion here:
 *  the backlink source owner already removes property machinery. */
export const mentionThreadBlockIds = async (ctx: QueryCtx, workspaceId: string, targetId: string): Promise<ReadonlySet<string>> => {
  // Thread-type edits change membership; workspace-wide re-runs share the batch.
  ctx.depend({kind: 'plugin', channel: TYPED_BLOCKS_TYPE_CHANNEL, key: typedBlocksTypeKey(workspaceId, THREAD_TYPE)})
  const roots = await ctx.run(THREAD_IDS_FOR_BLOCK_QUERY, {workspaceId, id: targetId})
  const batcher = batcherFor(ctx.db)
  const ids = new Set((await Promise.all(roots.map(id => batcher.request(id, workspaceId)))).flat())
  for (const id of ids) {
    ctx.depend({kind: 'plugin', channel: TYPED_BLOCKS_STRUCTURE_CHANNEL, key: typedBlocksStructureKey(workspaceId, id)})
    ctx.depend({kind: 'parent-edge', parentId: id})
    ctx.depend({
      kind: 'plugin', channel: TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL,
      key: typedBlocksReferenceFieldKey(workspaceId, id, annotationTargetProp.name),
    })
  }
  return ids
}
