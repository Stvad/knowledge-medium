import {z} from 'zod'
import {defineQuery, type BlockData, type Schema} from '@/data/api'
import type {BlockRow} from '@/data/blockSchema'

export const CONTRIBUTOR_PROFILES_BY_IDS_QUERY = 'contributors.profilesByIds'

const resultSchema: Schema<BlockData[]> = {parse: input => input as BlockData[]}
const QUERY_CHUNK_SIZE = 500
const asBlockRows = (rows: readonly BlockRow[]): readonly Record<string, unknown>[] =>
  rows as unknown as readonly Record<string, unknown>[]

export const contributorProfilesByIdsQuery = defineQuery<
  {workspaceId: string; ids: string[]},
  BlockData[]
>({
  name: CONTRIBUTOR_PROFILES_BY_IDS_QUERY,
  argsSchema: z.object({workspaceId: z.string(), ids: z.array(z.string())}),
  resultSchema,
  resolve: async ({workspaceId, ids}, ctx) => {
    const uniqueIds = [...new Set(ids)]
    if (!workspaceId || uniqueIds.length === 0) return []

    // Missing IDs also need row deps so a newly-arrived profile refreshes this result.
    for (const id of uniqueIds) ctx.depend({kind: 'row', id})

    const rows: BlockRow[] = []
    for (let offset = 0; offset < uniqueIds.length; offset += QUERY_CHUNK_SIZE) {
      const chunk = uniqueIds.slice(offset, offset + QUERY_CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(', ')
      rows.push(...await ctx.db.getAll<BlockRow>(
        `SELECT * FROM blocks WHERE workspace_id = ? AND id IN (${placeholders})`,
        [workspaceId, ...chunk],
      ))
    }
    return ctx.hydrateBlocks(asBlockRows(rows), {declareRowDeps: false})
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    'contributors.profilesByIds': typeof contributorProfilesByIdsQuery
  }
}
