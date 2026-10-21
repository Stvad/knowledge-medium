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
import { DbMetrics, wrapDbWithMetrics } from './timingMetrics'

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
  failWhen?: (ids: string[]) => boolean
  rowsFor?: (id: string) => unknown[]
}) => {
  const statements: Statement[] = []
  const rowsFor = opts?.rowsFor ?? chainRowsFor
  const db = {
    getAll: vi.fn(async (_sql: string, params?: unknown[]) => {
      const ids = (params ?? []) as string[]
      statements.push({ids})
      if (opts?.failWhen?.(ids)) throw new Error(`read failed: ${ids.join(',')}`)
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

describe('ancestorWalk shared-work reporting', () => {
  /** The batcher only reaches the metrics layer through the db it was handed,
   *  so these cases need the wrapped one a Repo actually passes. */
  const meteredDb = () => {
    const {db, statements} = fakeDb()
    const metrics = new DbMetrics()
    const pool = metrics.contention
    return {
      db: wrapDbWithMetrics(db, metrics) as QueryReadDb,
      statements,
      pool,
      shared: () => pool.snapshot().sharedWork,
      /** Run `walk` as N concurrent query resolves would, each with an
       *  observation window of its own so the result can be judged. The COUNT
       *  decides nothing: a shared statement disqualifies every window across
       *  it, one or many. */
      asResolves: async <T>(n: number, walk: () => Promise<T>) => {
        const windows = Array.from({length: n}, () => pool.openWindow())
        try { return await walk() } finally { windows.forEach(w => pool.closeWindow(w)) }
      },
    }
  }

  it('reports one statement answering several separate resolves as shared work', async () => {
    const {db, statements, shared, asResolves} = meteredDb()

    await asResolves(2, () => Promise.all([ancestorWalk(db, 'a'), ancestorWalk(db, 'b')]))

    expect(statements.map(s => s.ids)).toEqual([['a', 'b']])
    // Both resolves saw an idle pool and recorded the same wall-clock. Without
    // this signal each is an independent measurement of a database at rest, and
    // the call count says two where there was one read.
    expect(shared()).toBeGreaterThan(0)
  })

  it('reports a second resolve joining an already-queued id as shared work', async () => {
    const {db, statements, shared, asResolves} = meteredDb()

    await asResolves(2, () => Promise.all([ancestorWalk(db, 'a'), ancestorWalk(db, 'a')]))

    expect(statements.map(s => s.ids)).toEqual([['a']])
    expect(shared()).toBeGreaterThan(0)
  })

  it('counts one shared read per statement, not one per caller that joined', async () => {
    const {db, statements, shared, asResolves} = meteredDb()

    await asResolves(3, () => Promise.all([
      ancestorWalk(db, 'a'), ancestorWalk(db, 'a'), ancestorWalk(db, 'a'),
    ]))

    expect(statements.map(s => s.ids)).toEqual([['a']])
    // One statement was issued, so one shared read happened. Noting it per
    // JOIN reported two, which is a caller-join count under a shared-read
    // count's name — and duplicate-id fan-out is the common case, not a corner.
    expect(shared()).toBe(1)
  })

  // `core.manyAncestors` and `core.recentActivity` both do exactly this: one
  // resolver asking the batcher for every id it was handed. That batch IS the
  // resolve's own work, and reporting it costs those queries their clean
  // samples — accepted, because from here it is indistinguishable from the case
  // below, and letting it through would record a shared read as a clean one.
  it('reports shared work even when the callers may all be one resolve', async () => {
    const {db, statements, shared, asResolves} = meteredDb()

    await asResolves(1, () => Promise.all([
      ancestorWalk(db, 'a'), ancestorWalk(db, 'b'), ancestorWalk(db, 'c'),
    ]))

    expect(statements.map(s => s.ids)).toEqual([['a', 'b', 'c']])
    expect(shared()).toBe(1)
  })

  // The caller with no observation window at all — `Repo.load` with ancestors
  // goes through this batcher outside any query. The window open across that
  // flush absorbed its id, so it must not come out clean.
  it('reports shared work when a caller outside any window joins the batch', async () => {
    const {db, shared, pool} = meteredDb()

    const window = pool.openWindow()
    await Promise.all([ancestorWalk(db, 'a'), ancestorWalk(db, 'b')])
    const clean = pool.closeWindow(window)

    expect(shared()).toBe(1)
    expect(clean).toBe(false)
  })

  it('reports nothing shared when one caller is answered alone', async () => {
    const {db, shared, asResolves} = meteredDb()

    await asResolves(1, () => ancestorWalk(db, 'a'))

    // The discriminator has to stay silent here, or every ancestors resolve is
    // contended and the query keeps no comparable samples at all.
    expect(shared()).toBe(0)
  })
})
