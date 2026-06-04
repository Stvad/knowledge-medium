// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'

const WS = 'ws-1'
const count = async (h: TestDb, table: string): Promise<number> =>
  (await h.db.get<{n: number}>(`SELECT COUNT(*) AS n FROM ${table}`)).n

describe('resetTestDb', () => {
  let h: TestDb
  beforeAll(async () => { h = await createTestDb() })
  afterAll(async () => { await h.cleanup() })
  beforeEach(async () => { await resetTestDb(h.db) })

  const seed = async (): Promise<Repo> => {
    const repo = new Repo({
      db: h.db,
      cache: new BlockCache(),
      user: {id: 'u1'},
      registerKernelProcessors: false,
      startSyncObserver: false,
    })
    repo.setActiveWorkspaceId(WS)
    await repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Target page'})
      await tx.create({id: 'b', workspaceId: WS, parentId: 'a', orderKey: 'a0', content: 'a child block'})
    }, {scope: ChangeScope.BlockDefault})
    return repo
  }

  it('leaves all data tables and tx_context empty after a reset', async () => {
    await seed()
    expect(await count(h, 'blocks')).toBeGreaterThan(0)
    expect(await count(h, 'ps_crud')).toBeGreaterThan(0) // writes routed to the upload queue

    await resetTestDb(h.db)

    for (const table of ['blocks', 'blocks_synced', 'block_aliases', 'block_types',
      'block_references', 'blocks_fts_rowids', 'row_events', 'command_events',
      'ps_crud', 'ps_crud_rejected', 'workspaces', 'workspace_members']) {
      expect(await count(h, table), `${table} should be empty`).toBe(0)
    }
    const ctx = await h.db.get<Record<string, unknown>>('SELECT * FROM tx_context')
    expect(ctx).toMatchObject({tx_id: null, user_id: null, scope: null, source: null})
    // FTS stays queryable (not corrupted by the reset) and is empty.
    expect((await h.db.getAll('SELECT rowid FROM blocks_fts')).length).toBe(0)
  })

  it('isolates tests: a fresh Repo sees a clean slate, then creates + queries', async () => {
    // Runs after the test above; the beforeEach reset must have wiped its rows.
    expect(await count(h, 'blocks')).toBe(0)
    const repo = await seed()
    const tree = await repo.query.subtree({id: 'a'}).load()
    expect(tree.map(b => b.id).sort()).toEqual(['a', 'b'])
  })

  it('restarts ps_crud autoincrement ids after reset', async () => {
    await seed()
    const firstId = (await h.db.get<{id: number}>('SELECT MIN(id) AS id FROM ps_crud')).id
    await resetTestDb(h.db)
    await seed()
    const afterId = (await h.db.get<{id: number}>('SELECT MIN(id) AS id FROM ps_crud')).id
    expect(afterId).toBe(firstId)
  })
})
