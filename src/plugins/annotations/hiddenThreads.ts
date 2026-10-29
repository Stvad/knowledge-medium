import {z} from 'zod'
import {defineQuery, type Schema} from '@/data/api'
import {buildQualifiedBlockColumnsSql} from '@/data/blockSchema'
import {TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, typedBlocksReferenceFieldKey} from '@/data/invalidation'
import {dependOnRecognitionParams} from '@/data/internals/kernelQueries'
import {recognizedFieldRowSql} from '@/data/internals/treeQueries'
import {hasBlockType} from '@/data/properties'
import {annotationTargetProp, THREAD_TYPE, threadIsOpen} from './schema.ts'

export const OPEN_THREADS_UNDER_QUERY = 'annotations.openThreadsUnder'

/** Every visible descendant of the bound block, each with the thread roots
 *  anchored to it (one row per pair; NULL root for none). Binds the block id,
 *  the recognition params once per `recognizedFieldRowSql`, then the edge's
 *  field name. UNION dedups, so a cycle ends. */
const DESCENDANT_THREADS_SQL = `
  WITH RECURSIVE below(id) AS (
    SELECT child.id FROM blocks child
     WHERE child.parent_id = ? AND child.deleted = 0
       AND NOT (${recognizedFieldRowSql('child')})
    UNION
    SELECT child.id FROM below
      JOIN blocks child ON child.parent_id = below.id
     WHERE child.deleted = 0
       AND NOT (${recognizedFieldRowSql('child')})
  )
  SELECT below.id AS km_below_id, ${buildQualifiedBlockColumnsSql('root')}
    FROM below
    LEFT JOIN block_references edge ON edge.target_id = below.id AND edge.source_field = ?
    LEFT JOIN blocks root ON root.id = edge.source_id AND root.deleted = 0
`

const idsSchema: Schema<string[]> = {parse: input => input as string[]}

/** The open threads anchored below `id` (its visible descendants, at any
 *  depth, not `id` itself): what a collapsed block hides from the margin.
 *  Re-resolves on a structural change anywhere below (a parent edge per
 *  walked block), on a thread added to or removed from any descendant (its
 *  target-edge key) and on a root's own edit, such as its status. */
export const openThreadsUnderQuery = defineQuery<{workspaceId: string; id: string}, string[]>({
  name: OPEN_THREADS_UNDER_QUERY,
  argsSchema: z.object({workspaceId: z.string(), id: z.string()}),
  resultSchema: idsSchema,
  resolve: async ({workspaceId, id}, ctx) => {
    if (!workspaceId || !id) return []
    const recognition = dependOnRecognitionParams(ctx)
    const rows = await ctx.db.getAll<Record<string, unknown>>(
      DESCENDANT_THREADS_SQL, [id, ...recognition, ...recognition, annotationTargetProp.name],
    )
    ctx.depend({kind: 'parent-edge', parentId: id})
    const walked = new Set<string>()
    const roots: Record<string, unknown>[] = []
    for (const {km_below_id, ...root} of rows) {
      const below = km_below_id as string
      if (!walked.has(below)) {
        walked.add(below)
        ctx.depend({kind: 'parent-edge', parentId: below})
        ctx.depend({
          kind: 'plugin',
          channel: TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL,
          key: typedBlocksReferenceFieldKey(workspaceId, below, annotationTargetProp.name),
        })
      }
      if (root.id !== null) roots.push(root)
    }
    return ctx.hydrateBlocks(roots)
      .filter(root => hasBlockType(root, THREAD_TYPE) && threadIsOpen(root))
      .map(root => root.id)
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [OPEN_THREADS_UNDER_QUERY]: typeof openThreadsUnderQuery
  }
}
