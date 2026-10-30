// @vitest-environment node
/**
 * `ReadBatcher` — the transport the per-block read batchers share. What it
 * owns is the statement each wave turns into, so the spec here records the
 * statements and answers each id with a value naming the statement it came
 * from. What a statement reads belongs to each batcher's own tests.
 */

import { describe, expect, it } from 'vitest'
import type { QueryReadDb } from '@/data/api'
import { ReadBatcher, readBatcherPerDb, type ReadBatchSpec } from './readBatch'
import { DbMetrics, wrapDbWithMetrics } from './timingMetrics'

interface Statement<K> {
  key: K
  ids: readonly string[]
}

const unusedDb = {
  getAll: async () => { throw new Error('unused') },
  getOptional: async () => { throw new Error('unused') },
  get: async () => { throw new Error('unused') },
} as unknown as QueryReadDb

/** Answers `<id>@<statement number>`, and fails the statements named in
 *  `failStatements` (1-based). */
const recordingBatcher = <K = void>(opts: {
  db?: QueryReadDb
  failStatements?: number[]
  spec?: Omit<ReadBatchSpec<K, string>, 'read'>
} = {}) => {
  const statements: Statement<K>[] = []
  const batcher = new ReadBatcher<K, string>(opts.db ?? unusedDb, {
    ...opts.spec,
    read: async (key, ids) => {
      statements.push({key, ids})
      const n = statements.length
      if (opts.failStatements?.includes(n)) throw new Error(`statement ${n} failed`)
      return id => `${id}@${n}`
    },
  })
  return {batcher, statements}
}

describe('ReadBatcher', () => {
  it('answers every request made in one tick with ONE statement', async () => {
    const {batcher, statements} = recordingBatcher()

    const answers = await Promise.all(['a', 'b', 'c'].map(id => batcher.request(id)))

    expect(statements.map(s => s.ids)).toEqual([['a', 'b', 'c']])
    expect(answers).toEqual(['a@1', 'b@1', 'c@1'])
  })

  it('reads a repeated id once and answers every caller', async () => {
    const {batcher, statements} = recordingBatcher()

    const answers = await Promise.all(['a', 'b', 'a'].map(id => batcher.request(id)))

    expect(statements.map(s => s.ids)).toEqual([['a', 'b']])
    expect(answers).toEqual(['a@1', 'b@1', 'a@1'])
  })

  it('opens a new batch for a request that arrives while a statement is in flight', async () => {
    // A late id cannot join a statement already issued: it would never be
    // read, and the batch it joined would be read twice.
    const {batcher, statements} = recordingBatcher()

    const first = batcher.request('a')
    await Promise.resolve()
    const second = await batcher.request('b')

    expect(await first).toBe('a@1')
    expect(second).toBe('b@2')
    expect(statements.map(s => s.ids)).toEqual([['a'], ['b']])
  })

  it('reads keys that cannot share a statement separately, each with its own key', async () => {
    const {batcher, statements} = recordingBatcher<string>()

    const answers = await Promise.all([
      batcher.request('a', 'x'), batcher.request('a', 'y'), batcher.request('b', 'x'),
    ])

    expect(statements).toEqual([{key: 'x', ids: ['a', 'b']}, {key: 'y', ids: ['a']}])
    expect(answers).toEqual(['a@1', 'a@2', 'b@1'])
  })

  it('groups by the spec\'s comparison rather than identity when it gives one', async () => {
    const {batcher, statements} = recordingBatcher<{ws: string}>({
      spec: {sameGroup: (a, b) => a.ws === b.ws},
    })

    await Promise.all([batcher.request('a', {ws: 'w'}), batcher.request('b', {ws: 'w'})])

    expect(statements.map(s => s.ids)).toEqual([['a', 'b']])
  })

  it('splits a group past the per-statement id bound', async () => {
    const {batcher, statements} = recordingBatcher({spec: {maxIdsPerStatement: 2}})

    const answers = await Promise.all(['a', 'b', 'c'].map(id => batcher.request(id)))

    expect(statements.map(s => s.ids)).toEqual([['a', 'b'], ['c']])
    expect(answers).toEqual(['a@1', 'b@1', 'c@2'])
  })

  it('rejects only the chunk whose statement failed', async () => {
    const {batcher} = recordingBatcher({failStatements: [1], spec: {maxIdsPerStatement: 2}})

    const settled = await Promise.allSettled(['a', 'b', 'c', 'a'].map(id => batcher.request(id)))

    expect(settled.map(s => s.status)).toEqual(['rejected', 'rejected', 'fulfilled', 'rejected'])
    expect(settled[2]).toMatchObject({value: 'c@2'})
  })

  it('rejects only the group whose statement failed', async () => {
    const {batcher} = recordingBatcher<string>({failStatements: [1]})

    const settled = await Promise.allSettled([batcher.request('a', 'x'), batcher.request('a', 'y')])

    expect(settled.map(s => s.status)).toEqual(['rejected', 'fulfilled'])
  })

  it('reads again for the next wave after a failed statement', async () => {
    const {batcher} = recordingBatcher({failStatements: [1]})

    await expect(batcher.request('a')).rejects.toThrow('statement 1 failed')
    expect(await batcher.request('a')).toBe('a@2')
  })
})

describe('ReadBatcher shared-work reporting', () => {
  const metered = (maxIdsPerStatement?: number) => {
    const metrics = new DbMetrics()
    const db = wrapDbWithMetrics(unusedDb, metrics) as QueryReadDb
    return {
      ...recordingBatcher({db, spec: {maxIdsPerStatement}}),
      shared: () => metrics.contention.snapshot().sharedWork,
    }
  }

  it('reports one shared read per statement that answers more than one caller', async () => {
    const {batcher, shared} = metered(2)

    // Two statements of two callers each, then one caller alone.
    await Promise.all(['a', 'b', 'c', 'c'].map(id => batcher.request(id)))
    await batcher.request('d')

    expect(shared()).toBe(2)
  })
})

describe('readBatcherPerDb', () => {
  it('hands out one batcher per read surface', () => {
    const other = {...unusedDb} as QueryReadDb
    const batcherFor = readBatcherPerDb(db => ({db}))

    expect(batcherFor(unusedDb)).toBe(batcherFor(unusedDb))
    expect(batcherFor(other)).not.toBe(batcherFor(unusedDb))
    expect(batcherFor(other).db).toBe(other)
  })
})
