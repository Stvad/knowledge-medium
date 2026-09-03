// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
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

  it('a Repo outliving resetTestDb cannot collide with the next Repo on command_events.tx_id', async () => {
    // #866: `command_events.tx_id` is a PRIMARY KEY on the SHARED db, while
    // the shared-db pattern hands every Repo a `newId` counter restarting at
    // `gen-1`. Both Repos below write the same number of times, so their
    // counters stay in lockstep: with tx ids derived from `newId`, `live`'s
    // second write collides with the one `abandoned` landed after the reset.
    const write = (repo: Repo, id: string) => repo.tx(
      tx => tx.create({ id, workspaceId: 'ws-1', parentId: null, orderKey: 'a0' }),
      { scope: ChangeScope.BlockDefault },
    )

    const { repo: abandoned } = createTestRepo({ db: shared.db })
    await write(abandoned, 'stale-1')

    await resetTestDb(shared.db)
    // The leak (#813, still open): nothing disposed `abandoned`, so it keeps
    // writing into the next test's database.
    await write(abandoned, 'stale-2')

    const { repo: live } = createTestRepo({ db: shared.db })
    await write(live, 'live-1')
    await write(live, 'live-2')

    const rows = await shared.db.getAll<{tx_id: string}>('SELECT tx_id FROM command_events')
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map(row => row.tx_id)).size).toBe(3)
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
