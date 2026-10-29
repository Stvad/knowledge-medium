// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { NO_REGISTRY_RECOGNITION_PARAMS } from '@/data/internals/treeQueries'
import { BacklinkSourceBatcher } from '../sourceBatch.ts'

/** A read surface with no machinery, whose statement answers each target in
 *  its chunk with the count in `counts`. Records the targets of every read. */
const fakeDb = (counts: Record<string, number>, failReads: number[] = []) => {
  const statements: string[][] = []
  return {
    statements,
    getOptional: async <T>(): Promise<T | null> => null,
    get: async <T>(): Promise<T> => { throw new Error('unused') },
    getAll: async <T>(_sql: string, params?: unknown[]): Promise<T[]> => {
      const targets = (params ?? []).slice(1) as string[]
      statements.push(targets)
      if (failReads.includes(statements.length)) throw new Error(`read ${statements.length} failed`)
      return targets.map(t => ({target_id: t, count: counts[t]})) as T[]
    },
  }
}

const ALL_EDGES = {sql: '1', params: [], admitsAll: true}

const countOf = (batcher: BacklinkSourceBatcher, target: string) =>
  batcher.request('ws', target, 'count', NO_REGISTRY_RECOGNITION_PARAMS, ALL_EDGES).then(r => r.value)

describe('BacklinkSourceBatcher', () => {
  it('answers each target from its own chunk when a wave exceeds the bind ceiling', async () => {
    const db = fakeDb({a: 1, b: 2, c: 3})
    const batcher = new BacklinkSourceBatcher(db, 2)
    const answers = await Promise.all(['a', 'b', 'c', 'b'].map(t => countOf(batcher, t)))
    expect(answers).toEqual([1, 2, 3, 2])
    expect(db.statements).toEqual([['a', 'b'], ['c']])
  })

  it('rejects only the chunk whose read failed, and reads again for the next wave', async () => {
    const db = fakeDb({a: 1, b: 2, c: 3}, [1])
    const batcher = new BacklinkSourceBatcher(db, 2)
    const settled = await Promise.allSettled(['a', 'b', 'c'].map(t => countOf(batcher, t)))
    expect(settled.map(s => s.status)).toEqual(['rejected', 'rejected', 'fulfilled'])
    expect(await countOf(batcher, 'a')).toBe(1)
  })
})
