// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { workspaceBackfillsFacet, type WorkspaceBackfill } from '@/data/facets'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'

/** Properties of the shared `WorkspaceBackfill` runner, independent of any one
 *  backfill: when it is allowed to run, and what its writes are allowed to do
 *  to the user's undo stack. */

const WS = 'ws-backfill-runner'

let sharedDb: TestDb

/** A backfill that records its runs and writes one block, so the tx it used is
 *  observable through undo. */
const probeBackfill = (runs: string[]): WorkspaceBackfill => ({
  id: 'probe-backfill-v1',
  run: async ({workspaceId, tx}) => {
    runs.push(workspaceId)
    await tx(async t => {
      await t.update('target', {content: 'backfilled'})
    }, {description: 'probe backfill write'})
  },
})

const makeRepo = (
  backfill: WorkspaceBackfill,
  gate?: (cb: () => void) => () => void,
): Repo => {
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    ...(gate ? {backfillSyncGate: gate} : {}),
  })
  repo.setActiveWorkspaceId(WS)
  repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [backfill])
  return repo
}

const seedTarget = async (repo: Repo): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({id: 'target', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'original'})
  }, {scope: ChangeScope.BlockDefault, description: 'seed'})
}

const drain = async (repo: Repo): Promise<void> => {
  repo.scheduleWorkspaceBackfills(WS)
  await vi.runAllTimersAsync()
  await repo.awaitWorkspaceBackfills()
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('workspace backfill runner — sync gating', () => {
  it('does not run while the device is still catching up', async () => {
    // The hazard is not just "misses rows". `apply_block_patches` assigns
    // `properties_json` wholesale, so a write built from a stale local row
    // uploads the whole stale bag and drops property edits made elsewhere that
    // haven't arrived. A half-synced device must not write at all.
    const runs: string[] = []
    let openGate: (() => void) | undefined
    const repo = makeRepo(probeBackfill(runs), cb => { openGate = cb; return () => {} })
    await seedTarget(repo)

    await drain(repo)
    expect(runs).toEqual([])

    // Catch-up completes; the armed gate opens and the pass runs.
    openGate!()
    await vi.runAllTimersAsync()
    await repo.awaitWorkspaceBackfills()
    expect(runs).toEqual([WS])
  })

  it('records no completion marker while gated, so the next open retries', async () => {
    // The marker is the thing that makes a premature run permanent.
    const runs: string[] = []
    const repo = makeRepo(probeBackfill(runs), () => () => {})
    await seedTarget(repo)

    await drain(repo)

    const markers = await sharedDb.db.getAll<{key: string}>(
      "SELECT key FROM client_schema_state WHERE key LIKE 'workspace_backfill:%'",
    )
    expect(markers).toEqual([])
  })
})

describe('workspace backfill runner — undo', () => {
  it('keeps its writes off the user’s undo stack', async () => {
    // The pass fires ~10-30s after workspace open, i.e. while the user is
    // already editing. On the stack, their next cmd-Z reverts the backfill
    // instead of their own edit — and the marker is recorded, so it never
    // comes back.
    const runs: string[] = []
    const repo = makeRepo(probeBackfill(runs))
    await seedTarget(repo)
    // The user's own edit, made after the seed.
    await repo.tx(async tx => {
      await tx.update('target', {content: 'user edit'})
    }, {scope: ChangeScope.BlockDefault, description: 'user edit'})

    await drain(repo)
    expect(runs).toEqual([WS])
    expect((await repo.load('target'))?.content).toBe('backfilled')

    // One cmd-Z must land on the user's edit, not on the backfill.
    await repo.undo(ChangeScope.BlockDefault)
    expect((await repo.load('target'))?.content).toBe('original')
  })

  it('still uploads — suppressing undo must not make it a local-only write', async () => {
    // The whole point of a WorkspaceBackfill over a raw db.execute is that its
    // writes reach the server (the daily-note:date bug).
    const repo = makeRepo(probeBackfill([]))
    await seedTarget(repo)
    await sharedDb.db.execute('DELETE FROM ps_crud')

    await drain(repo)

    const ops = (await sharedDb.db.getAll<{data: string}>('SELECT data FROM ps_crud'))
      .map(r => JSON.parse(r.data) as {id: string})
      .filter(e => e.id === 'target')
    expect(ops.length).toBeGreaterThan(0)
  })
})
