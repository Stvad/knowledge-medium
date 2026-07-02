// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Control the gating providers + the singletons the GC wiring reads. The pure sweep is
// tested in mediaGc.test.ts; this file verifies the app wiring + settled-synced gating.
const h = vi.hoisted(() => ({
  remoteActive: true as boolean,
  userId: 'user-1' as string | null,
  hasSynced: true as boolean | undefined,
  workspaceRows: [] as { id: string }[],
  storedWs: new Set<string>(),
  stagedRecs: [] as Array<{ workspaceId: string }>,
  pendingRecs: [] as Array<{ workspaceId: string }>,
  failedRecs: [] as Array<{ workspaceId: string }>,
  // No declared params: vi.fn records actual call args regardless, so
  // `toHaveBeenCalledWith(user, ws)` / the returned set still work.
  purge: vi.fn(async () => {}),
  listWorkspaceIds: vi.fn(async () => h.storedWs),
  // runSingleOwner runs the work directly (no navigator.locks in node) and reports it ran;
  // a spy so a test can pin the lock NAME (mutual exclusion with the down-lane depends on it).
  runSingleOwner: vi.fn(async (_name: string, work: () => Promise<void>) => {
    await work()
    return true
  }),
  markers: null as unknown as import('./gcMarkerStore.js').GcMarkerStore,
}))

vi.mock('@/data/repoProvider.js', async (orig) => ({
  ...(await orig<typeof import('@/data/repoProvider.js')>()),
  isRemoteSyncActive: () => h.remoteActive,
  getActiveUserId: () => h.userId,
  getPowerSyncDb: () => ({
    currentStatus: { hasSynced: h.hasSynced },
    getAll: async () => h.workspaceRows,
  }),
}))
vi.mock('./byteStore.js', () => ({
  getByteStore: () => ({ listWorkspaceIds: h.listWorkspaceIds, purgeWorkspace: h.purge }),
}))
vi.mock('./uploadStore.js', () => ({
  getByteUploadStore: () => ({
    listByStatus: async (_u: string, status: string) =>
      status === 'staged'
        ? h.stagedRecs
        : status === 'pending'
          ? h.pendingRecs
          : status === 'failed'
            ? h.failedRecs
            : [],
  }),
}))
vi.mock('./laneLock.js', () => ({ runSingleOwner: h.runSingleOwner }))
vi.mock('./gcMarkerStore.js', async (orig) => ({
  ...(await orig<typeof import('./gcMarkerStore.js')>()),
  getGcMarkerStore: () => h.markers,
}))

import { InMemoryGcMarkerStore } from './gcMarkerStore.js'
import { downLaneLockName } from './assetDownLane.js'
import { GC_GRACE_MS, runMediaGcSweep } from './assetGc.js'

const USER = 'user-1'
const oldEnough = () => Date.now() - 2 * GC_GRACE_MS

beforeEach(() => {
  h.remoteActive = true
  h.userId = USER
  h.hasSynced = true
  h.workspaceRows = []
  h.storedWs = new Set()
  h.stagedRecs = []
  h.pendingRecs = []
  h.failedRecs = []
  h.markers = new InMemoryGcMarkerStore()
  h.purge.mockClear()
  h.listWorkspaceIds.mockClear()
  h.runSingleOwner.mockClear()
})
afterEach(() => vi.clearAllMocks())

describe('runMediaGcSweep — gating', () => {
  it('is a no-op in a local-only session (remote sync off)', async () => {
    h.remoteActive = false
    h.storedWs = new Set(['ws-gone'])
    await runMediaGcSweep()
    expect(h.listWorkspaceIds).not.toHaveBeenCalled()
    expect(h.purge).not.toHaveBeenCalled()
  })

  it('is a no-op when signed out', async () => {
    h.userId = null
    h.storedWs = new Set(['ws-gone'])
    await runMediaGcSweep()
    expect(h.listWorkspaceIds).not.toHaveBeenCalled()
    expect(h.purge).not.toHaveBeenCalled()
  })

  it('is a no-op until initial sync has settled', async () => {
    h.hasSynced = false
    h.storedWs = new Set(['ws-gone'])
    await runMediaGcSweep()
    expect(h.listWorkspaceIds).not.toHaveBeenCalled()
    expect(h.purge).not.toHaveBeenCalled()
  })
})

describe('runMediaGcSweep — wiring', () => {
  it('purges a workspace absent from the local `workspaces` list once past grace', async () => {
    h.storedWs = new Set(['ws-gone'])
    h.workspaceRows = [{ id: 'ws-keep' }] // ws-gone is NOT a member → orphaned
    await h.markers.set({ userId: USER, workspaceId: 'ws-gone', firstSeenOrphanedAt: oldEnough() })

    await runMediaGcSweep()

    expect(h.purge).toHaveBeenCalledWith(USER, 'ws-gone')
    // The purge MUST hold the down-lane's own lock name, or it loses mutual exclusion with
    // an in-flight `put` (the purgeWorkspace coordination caveat).
    expect(h.runSingleOwner).toHaveBeenCalledWith(downLaneLockName(USER, 'ws-gone'), expect.any(Function))
    expect(await h.markers.get(USER, 'ws-gone')).toBeNull() // cleared after purge
  })

  it('never purges a workspace the user is still a member of', async () => {
    h.storedWs = new Set(['ws-A'])
    h.workspaceRows = [{ id: 'ws-A' }]
    await h.markers.set({ userId: USER, workspaceId: 'ws-A', firstSeenOrphanedAt: oldEnough() })

    await runMediaGcSweep()

    expect(h.purge).not.toHaveBeenCalled()
    expect(await h.markers.get(USER, 'ws-A')).toBeNull() // stale marker cleared, not acted on
  })

  it.each([
    ['pending', () => (h.pendingRecs = [{ workspaceId: 'ws-gone' }])],
    ['staged', () => (h.stagedRecs = [{ workspaceId: 'ws-gone' }])],
    ['failed', () => (h.failedRecs = [{ workspaceId: 'ws-gone' }])], // never uploaded, no recovery actor yet
  ])('defers purging an orphaned workspace with a %s (sole-copy) upload record', async (_status, seed) => {
    h.storedWs = new Set(['ws-gone'])
    h.workspaceRows = []
    seed() // an un-uploaded capture — its bytes may be the only copy anywhere
    await h.markers.set({ userId: USER, workspaceId: 'ws-gone', firstSeenOrphanedAt: oldEnough() })

    await runMediaGcSweep()

    expect(h.purge).not.toHaveBeenCalled()
    expect(await h.markers.get(USER, 'ws-gone')).not.toBeNull() // kept for a later retry
  })

  it('only marks (never purges) an orphan on its first sighting', async () => {
    h.storedWs = new Set(['ws-gone'])
    h.workspaceRows = []
    // no pre-seeded marker → first sighting

    await runMediaGcSweep()

    expect(h.purge).not.toHaveBeenCalled()
    expect(await h.markers.get(USER, 'ws-gone')).not.toBeNull() // grace clock started
  })
})
