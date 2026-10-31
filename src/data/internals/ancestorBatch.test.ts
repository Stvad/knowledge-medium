// @vitest-environment node
/**
 * `ancestorWalk` — the ancestor walk's spec on `ReadBatcher`: its rows-to-walk
 * mapping, its per-statement id bound, and one batcher per database. The
 * transport (coalescing, failure scope, shared-work reporting) belongs to
 * `readBatch.test.ts`; the walk's SQL to `treeQueries.test.ts` and
 * `kernelQueries.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest'
import type { QueryReadDb } from '@/data/api'
import { ancestorWalk } from './ancestorBatch'

interface Statement {
  ids: string[]
}

/** The seed at depth 0, then `<id>-p` → `<id>-gp`, so a returned row
 *  identifies the seed it belongs to by value and not merely by
 *  position. */
const chainRowsFor = (id: string) => [
  {id, chain_start_id: id, depth: 0, parent_id: `${id}-p`},
  {id: `${id}-p`, chain_start_id: id, depth: 1, parent_id: `${id}-gp`},
  {id: `${id}-gp`, chain_start_id: id, depth: 2, parent_id: null},
]

const fakeDb = (opts?: {
  rowsFor?: (id: string) => unknown[]
}) => {
  const statements: Statement[] = []
  const rowsFor = opts?.rowsFor ?? chainRowsFor
  const db = {
    getAll: vi.fn(async (_sql: string, params?: unknown[]) => {
      const ids = (params ?? []) as string[]
      statements.push({ids})
      return ids.flatMap(rowsFor)
    }),
    getOptional: vi.fn(),
    get: vi.fn(),
  } as unknown as QueryReadDb
  return {db, statements}
}

const idsOf = (walk: {chain: readonly {chain_start_id: string}[]}) =>
  [...new Set(walk.chain.map(row => row.chain_start_id))]

describe('ancestorWalk', () => {
  it('answers walks started in one tick with ONE statement', async () => {
    const {db, statements} = fakeDb()

    const chains = await Promise.all(
      ['a', 'b', 'c'].map(id => ancestorWalk(db, id)),
    )

    expect(statements).toHaveLength(1)
    expect(statements[0].ids).toEqual(['a', 'b', 'c'])
    expect(chains.map(idsOf)).toEqual([['a'], ['b'], ['c']])
    expect(chains[0].chain.map(row => row.id)).toEqual(['a-p', 'a-gp'])
    expect(chains[0].stoppedAtParentId).toBeNull()
  })

  it('names the parent a truncated walk stopped at', async () => {
    // The chain is what the walk could REACH; the row it names is absent
    // precisely because it could not (soft-deleted, or not materialized
    // yet). No chain can say that about itself at any length — including
    // zero, where a cut at the first hop and a root are both `[]`.
    const {db} = fakeDb({rowsFor: id => [
      {id, chain_start_id: id, depth: 0, parent_id: `${id}-p`},
      {id: `${id}-p`, chain_start_id: id, depth: 1, parent_id: `${id}-gp`},
    ]})

    const cut = await ancestorWalk(db, 'a')

    expect(cut.chain.map(row => row.id)).toEqual(['a-p'])
    expect(cut.stoppedAtParentId).toBe('a-gp')
  })

  it('names the first hop when the chain is empty', async () => {
    const {db} = fakeDb({rowsFor: id => [
      {id, chain_start_id: id, depth: 0, parent_id: `${id}-p`},
    ]})

    const cut = await ancestorWalk(db, 'a')

    expect(cut.chain).toEqual([])
    expect(cut.stoppedAtParentId).toBe('a-p')
  })

  it('names no parent for a block whose own row is gone', async () => {
    const {db} = fakeDb({rowsFor: () => []})

    expect(await ancestorWalk(db, 'a')).toEqual({stoppedAtParentId: null, chain: []})
  })

  it('splits past the per-statement id bound', async () => {
    const {db, statements} = fakeDb()
    const ids = Array.from({length: 501}, (_, i) => `id-${i}`)

    const chains = await Promise.all(ids.map(id => ancestorWalk(db, id)))

    expect(statements.map(s => s.ids.length)).toEqual([500, 1])
    expect(idsOf(chains[500])).toEqual(['id-500'])
  })

  it('keeps separate databases on separate queues', async () => {
    const one = fakeDb()
    const other = fakeDb()

    await Promise.all([
      ancestorWalk(one.db, 'a'),
      ancestorWalk(other.db, 'b'),
    ])

    expect(one.statements.map(s => s.ids)).toEqual([['a']])
    expect(other.statements.map(s => s.ids)).toEqual([['b']])
  })
})
