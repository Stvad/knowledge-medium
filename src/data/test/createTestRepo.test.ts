// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'

let shared: TestDb
beforeAll(async () => { shared = await createTestDb() })
afterAll(async () => { await shared.cleanup() })
beforeEach(async () => { await resetTestDb(shared.db) })

describe('createTestRepo', () => {
  it('assembles a working Repo: tx.create round-trips with deterministic ids and the default user', async () => {
    const { repo } = createTestRepo({ db: shared.db })

    let createdId = ''
    await repo.tx(async tx => {
      createdId = await tx.create({
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a0',
        content: 'hello',
      })
    }, { scope: ChangeScope.BlockDefault })

    // The harness's default newId generator (a `gen-<n>` counter) is in effect.
    expect(createdId).toMatch(/^gen-\d+$/)

    const loaded = await repo.load(createdId)
    expect(loaded?.content).toBe('hello')
    expect(loaded?.createdBy).toBe('test-user')
  })

  it('honors a custom user', async () => {
    const { repo } = createTestRepo({ db: shared.db, user: { id: 'alice' } })
    let id = ''
    await repo.tx(async tx => {
      id = await tx.create({ workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: '' })
    }, { scope: ChangeScope.BlockDefault })
    expect((await repo.load(id))?.createdBy).toBe('alice')
  })
})
