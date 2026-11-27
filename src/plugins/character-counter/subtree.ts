import { z } from 'zod'
import { defineQuery, type Query, type SubtreeRow, type TypedBlockQuery } from '@/data/api'
import { resolveTypedBlockIds, typedBlocksArgsSchema } from '@/data/internals/kernelQueries'

export const COUNTER_SUBTREE_QUERY = 'character-counter.subtree'

type CounterSubtreeArgs = {id: string; exclude: TypedBlockQuery}

declare module '@/data/api' {
  interface QueryRegistry {
    [COUNTER_SUBTREE_QUERY]: typeof counterSubtreeQuery
  }
}

export const counterSubtreeQuery: Query<CounterSubtreeArgs, SubtreeRow[]> = defineQuery<CounterSubtreeArgs, SubtreeRow[]>({
  name: COUNTER_SUBTREE_QUERY,
  argsSchema: z.object({id: z.string(), exclude: typedBlocksArgsSchema}).strict(),
  resultSchema: {parse: (rows): SubtreeRow[] => rows as SubtreeRow[]},
  resolve: async ({id, exclude}, ctx) => {
    const rows = await ctx.run('core.subtree', {id, propertyChildren: 'none'})
    const excluded = new Set(await resolveTypedBlockIds(exclude, ctx, rows.map(row => row.id)))
    // Parents are visited before children, so one pass drops each excluded branch.
    return rows.filter(row => {
      if (row.parentId !== null && excluded.has(row.parentId)) excluded.add(row.id)
      return !excluded.has(row.id)
    })
  },
})
