// @vitest-environment node
/**
 * `ancestorChainRows` — the coalescing that makes one handle per id
 * affordable. Its whole job is the statement COUNT, so that is what the
 * fake db here records; correctness of the walk itself belongs to
 * `treeQueries.test.ts` and `kernelQueries.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest'
import type { QueryReadDb } from '@/data/api'
import { ancestorChainRows } from './ancestorBatch'

interface Statement {
  ids: string[]
}

/** Chains are `<id>-p` → `<id>-gp`, so a returned row identifies the
 *  seed it belongs to by value and not merely by position. */
const chainRowsFor = (id: string) => [
  {id: `${id}-p`, chain_start_id: id},
  {id: `${id}-gp`, chain_start_id: id},
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

const idsOf = (rows: readonly {chain_start_id: string}[]) =>
  [...new Set(rows.map(row => row.chain_start_id))]

describe('ancestorChainRows', () => {
  it('answers walks started in one tick with ONE statement', async () => {
    const {db, statements} = fakeDb()

    const chains = await Promise.all(
      ['a', 'b', 'c'].map(id => ancestorChainRows(db, id)),
    )

    expect(statements).toHaveLength(1)
    expect(statements[0].ids).toEqual(['a', 'b', 'c'])
    expect(chains.map(idsOf)).toEqual([['a'], ['b'], ['c']])
    expect(chains[0].map(row => row.id)).toEqual(['a-p', 'a-gp'])
  })

  it('reads a repeated id once and gives both callers the chain', async () => {
    const {db, statements} = fakeDb()

    const [first, second] = await Promise.all([
      ancestorChainRows(db, 'a'),
      ancestorChainRows(db, 'a'),
    ])

    expect(statements[0].ids).toEqual(['a'])
    expect(first.map(row => row.id)).toEqual(['a-p', 'a-gp'])
    expect(second).toEqual(first)
  })

  it('opens a new batch for an id that arrives while a read is in flight', async () => {
    // The batch is taken before the first await, so a late id cannot
    // join a statement that has already been issued — it must get its
    // own rather than resolve empty.
    const {db, statements} = fakeDb()

    const first = ancestorChainRows(db, 'a')
    await Promise.resolve()
    const second = await ancestorChainRows(db, 'b')

    expect(await first).toHaveLength(2)
    expect(idsOf(second)).toEqual(['b'])
    expect(statements.map(s => s.ids)).toEqual([['a'], ['b']])
  })

  it('splits past the per-statement id bound', async () => {
    const {db, statements} = fakeDb()
    const ids = Array.from({length: 501}, (_, i) => `id-${i}`)

    const chains = await Promise.all(ids.map(id => ancestorChainRows(db, id)))

    expect(statements.map(s => s.ids.length)).toEqual([500, 1])
    expect(idsOf(chains[500])).toEqual(['id-500'])
  })

  it('keeps the recents feed default window in one statement', async () => {
    // The largest set any surface asks for today. A bound below it would
    // put the cold-storage path on serialized round trips.
    const {db, statements} = fakeDb()
    const ids = Array.from({length: 200}, (_, i) => `id-${i}`)

    await Promise.all(ids.map(id => ancestorChainRows(db, id)))

    expect(statements).toHaveLength(1)
  })

  it('confines a failed read to its own chunk', async () => {
    const ids = Array.from({length: 501}, (_, i) => `id-${i}`)
    const {db} = fakeDb({failWhen: chunk => chunk.length === 500})

    const settled = await Promise.allSettled(
      ids.map(id => ancestorChainRows(db, id)),
    )

    expect(settled.slice(0, 500).every(r => r.status === 'rejected')).toBe(true)
    expect(settled[500]).toMatchObject({status: 'fulfilled'})
  })

  it('rejects every caller waiting on a failed id, not just the first', async () => {
    const {db} = fakeDb({failWhen: () => true})

    const settled = await Promise.allSettled([
      ancestorChainRows(db, 'a'),
      ancestorChainRows(db, 'a'),
    ])

    expect(settled.map(r => r.status)).toEqual(['rejected', 'rejected'])
  })

  it('keeps separate databases on separate queues', async () => {
    const one = fakeDb()
    const other = fakeDb()

    await Promise.all([
      ancestorChainRows(one.db, 'a'),
      ancestorChainRows(other.db, 'b'),
    ])

    expect(one.statements.map(s => s.ids)).toEqual([['a']])
    expect(other.statements.map(s => s.ids)).toEqual([['b']])
  })
})
