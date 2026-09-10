// @vitest-environment node
/**
 * `ancestorWalk` — the coalescing that makes one handle per id
 * affordable. Its whole job is the statement COUNT, so that is what the
 * fake db here records; correctness of the walk itself belongs to
 * `treeQueries.test.ts` and `kernelQueries.test.ts`.
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

const fakeDb = (opts?: {failWhen?: (ids: string[]) => boolean}) => {
  const statements: Statement[] = []
  const db = {
    getAll: vi.fn(async (_sql: string, params?: unknown[]) => {
      const ids = (params ?? []) as string[]
      statements.push({ids})
      if (opts?.failWhen?.(ids)) throw new Error(`read failed: ${ids.join(',')}`)
      return ids.flatMap(chainRowsFor)
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
    expect(chains[0].seed?.id).toBe('a')
  })

  it('reads a repeated id once and gives both callers the chain', async () => {
    const {db, statements} = fakeDb()

    const [first, second] = await Promise.all([
      ancestorWalk(db, 'a'),
      ancestorWalk(db, 'a'),
    ])

    expect(statements[0].ids).toEqual(['a'])
    expect(first.chain.map(row => row.id)).toEqual(['a-p', 'a-gp'])
    expect(second).toEqual(first)
  })

  it('opens a new batch for an id that arrives while a read is in flight', async () => {
    // The batch is taken before the first await, so a late id cannot
    // join a statement that has already been issued — it must get its
    // own rather than resolve empty.
    const {db, statements} = fakeDb()

    const first = ancestorWalk(db, 'a')
    await Promise.resolve()
    const second = await ancestorWalk(db, 'b')

    expect((await first).chain).toHaveLength(2)
    expect(idsOf(second)).toEqual(['b'])
    expect(statements.map(s => s.ids)).toEqual([['a'], ['b']])
  })

  it('splits past the per-statement id bound', async () => {
    const {db, statements} = fakeDb()
    const ids = Array.from({length: 501}, (_, i) => `id-${i}`)

    const chains = await Promise.all(ids.map(id => ancestorWalk(db, id)))

    expect(statements.map(s => s.ids.length)).toEqual([500, 1])
    expect(idsOf(chains[500])).toEqual(['id-500'])
  })

  it('keeps the recents feed default window in one statement', async () => {
    // Its first page, and the size a bound must clear to keep the common
    // cold-storage path off serialized round trips. Paging past the bound
    // does split, deliberately — see the constant.
    const {db, statements} = fakeDb()
    const ids = Array.from({length: 200}, (_, i) => `id-${i}`)

    await Promise.all(ids.map(id => ancestorWalk(db, id)))

    expect(statements).toHaveLength(1)
  })

  it('confines a failed read to its own chunk', async () => {
    const ids = Array.from({length: 501}, (_, i) => `id-${i}`)
    const {db} = fakeDb({failWhen: chunk => chunk.length === 500})

    const settled = await Promise.allSettled(
      ids.map(id => ancestorWalk(db, id)),
    )

    expect(settled.slice(0, 500).every(r => r.status === 'rejected')).toBe(true)
    expect(settled[500]).toMatchObject({status: 'fulfilled'})
  })

  it('rejects every caller waiting on a failed id, not just the first', async () => {
    const {db} = fakeDb({failWhen: () => true})

    const settled = await Promise.allSettled([
      ancestorWalk(db, 'a'),
      ancestorWalk(db, 'a'),
    ])

    expect(settled.map(r => r.status)).toEqual(['rejected', 'rejected'])
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
