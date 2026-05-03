import { z } from 'zod'
import { defineQuery, type BlockData, type Schema } from '@/data/api'
import {
  buildQualifiedBlockColumnsSql,
  type BlockRow,
} from '@/data/blockSchema'

export const BACKLINKS_FOR_BLOCK_QUERY = 'backlinks.forBlock'

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
  ORDER BY b.updated_at DESC, b.id
`

const blockDataArraySchema: Schema<BlockData[]> = {
  parse: (input) => input as BlockData[],
}

const asBlockRows = (rows: ReadonlyArray<BlockRow>): ReadonlyArray<Record<string, unknown>> =>
  rows as unknown as ReadonlyArray<Record<string, unknown>>

/** Every block in `workspaceId` whose references point at `id`.
 *
 *  Dep declaration:
 *    - `{kind:'row', id}` for the target row.
 *    - `{kind:'backlink-target', id}` for the precise incoming-edge set.
 *    - Per-source row deps from `hydrateBlocks`, so content edits on
 *      existing source rows update the rendered backlinks list. */
export const backlinksForBlockQuery = defineQuery<
  {workspaceId: string; id: string},
  BlockData[]
>({
  name: BACKLINKS_FOR_BLOCK_QUERY,
  argsSchema: z.object({workspaceId: z.string(), id: z.string()}),
  resultSchema: blockDataArraySchema,
  resolve: async ({workspaceId, id}, ctx) => {
    ctx.depend({kind: 'row', id})
    if (!workspaceId || !id) return []
    ctx.depend({kind: 'backlink-target', id})
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
