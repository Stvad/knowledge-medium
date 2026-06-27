// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
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
    // Two blocks is far below the preview cap.
    expect(health.uploadQueueApproximate).toBe(false)
    expect(health.uploadQueueBlocks).toBeGreaterThanOrEqual(0)
  })
})
