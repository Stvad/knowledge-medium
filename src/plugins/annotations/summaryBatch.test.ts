// @vitest-environment node
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import {NO_REGISTRY_RECOGNITION_PARAMS} from '@/data/internals/treeQueries'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {ThreadRootBatcher} from './summaryBatch.ts'

/** A read surface whose reads in `failReads` throw; the rest answer nothing.
 *  Records the ids bound to every read. */
const fakeDb = (failReads: number[]) => {
  const statements: string[][] = []
  return {
    statements,
    getOptional: async <T>(): Promise<T | null> => null,
    get: async <T>(): Promise<T> => { throw new Error('unused') },
    getAll: async <T>(_sql: string, params?: unknown[]): Promise<T[]> => {
      statements.push(JSON.parse(params!.at(-1) as string) as string[])
      if (failReads.includes(statements.length)) throw new Error(`read ${statements.length} failed`)
      return []
    },
  }
}

const rootOf = (batcher: ThreadRootBatcher, id: string) => batcher.request(id, NO_REGISTRY_RECOGNITION_PARAMS)

describe('ThreadRootBatcher', () => {
  it('rejects every root of a failed read, and reads again for the next wave', async () => {
    const db = fakeDb([1])
    const batcher = new ThreadRootBatcher(db)
    const settled = await Promise.allSettled(['a', 'b', 'a'].map(id => rootOf(batcher, id)))
    expect(settled.map(s => s.status)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(await rootOf(batcher, 'a')).toBeNull()
    expect(db.statements).toEqual([['a', 'b'], ['a']])
  })
})

describe('ThreadRootBatcher, over a database', () => {
  let db: TestDb
  beforeAll(async () => { db = await createTestDb() })
  afterAll(async () => { await db.cleanup() })
  beforeEach(async () => { await resetTestDb(db.db) })

  it('answers a live root with its comment count, and null for a deleted or missing one', async () => {
    const {repo} = createTestRepo({db: db.db})
    await repo.tx(async tx => {
      for (const id of ['r1', 'r2', 'gone']) await tx.create({id, workspaceId: 'ws', parentId: null, orderKey: `a-${id}`, content: id})
      await tx.create({id: 'c1', workspaceId: 'ws', parentId: 'r2', orderKey: 'a0', content: 'comment'})
      await tx.delete('gone')
    }, {scope: ChangeScope.BlockDefault})

    const batcher = new ThreadRootBatcher(db.db)
    const roots = await Promise.all(['r2', 'gone', 'missing', 'r1'].map(id => rootOf(batcher, id)))
    expect(roots.map(r => r && [r.row.id, r.commentCount])).toEqual([['r2', 1], null, null, ['r1', 0]])
  })
})
