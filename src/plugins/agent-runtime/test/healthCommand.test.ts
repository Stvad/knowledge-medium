// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { runHealthCommand } from '../healthCommand'

let shared: TestDb
beforeAll(async () => { shared = await createTestDb() })
afterAll(async () => { await shared.cleanup() })
beforeEach(async () => { await resetTestDb(shared.db) })

describe('runHealthCommand', () => {
  it('counts app-visible blocks, reports the active workspace, and shows an empty materialize backlog', async () => {
    const { repo } = createTestRepo({ db: shared.db })
    repo.setActiveWorkspaceId('ws-1')
    await repo.tx(async tx => {
      await tx.create({ workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'a' })
      await tx.create({ workspaceId: 'ws-1', parentId: null, orderKey: 'a1', content: 'b' })
    }, { scope: ChangeScope.BlockDefault })

    const health = await runHealthCommand(repo)
    expect(health.activeWorkspaceId).toBe('ws-1')
    expect(health.blocks).toBe(2)
    // Nothing was staged through the sync path in this test.
    expect(health.blocksSynced).toBe(0)
    expect(health.materializeBacklog).toBe(0)
    // The two created blocks are queued for upload as two distinct blocks,
    // well below the preview cap (so not flagged approximate). Asserting the
    // exact count guards against returning the wrong SQL (e.g. the raw ps_crud
    // row count, or blocksSynced) — a `>= 0` assertion would not.
    expect(health.uploadQueueBlocks).toBe(2)
    expect(health.uploadQueueApproximate).toBe(false)
    expect(health.syncDivergence).toEqual([])
  })

  it('reports a staged row the drain let go of that blocks does not hold', async () => {
    // What the probe counts is `syncDivergence.test.ts`'s; this pins that health
    // carries it. A newer staged row, flag clear, queue entry consumed.
    const { repo } = createTestRepo({ db: shared.db })
    await shared.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
      id: 'stuck', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'theirs',
      properties: {}, references: [], createdAt: 1, updatedAt: 2, userUpdatedAt: 2,
      createdBy: 'u', updatedBy: 'u', deleted: false,
    }))
    await shared.db.execute('UPDATE blocks_synced SET needs_apply = 0')
    await shared.db.execute('DELETE FROM blocks_synced_changes')

    expect((await runHealthCommand(repo)).syncDivergence).toEqual([{
      workspaceId: 'ws-1', materializability: 'copy', rematerializing: false, unapplied: 0,
      stranded: { missing: { count: 1, example: 'stuck' } },
    }])
  })
})
