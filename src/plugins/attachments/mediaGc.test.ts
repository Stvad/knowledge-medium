import { describe, expect, it } from 'vitest'
import { InMemoryGcMarkerStore, type GcMarkerStore } from './gcMarkerStore.js'
import { reclaimOrphanedWorkspaces, type MediaGcDeps } from './mediaGc.js'

const USER = 'user-1'
const GRACE = 1000

/** A controllable clock + deps builder. `stored`/`accessible` are the two workspace sets;
 *  `purge` records which workspaces were purged (default: succeeds). */
const setup = (opts: {
  stored: string[]
  accessible: string[]
  markers?: GcMarkerStore
  unUploaded?: Set<string>
  purgeRan?: boolean
  now?: number
}) => {
  const markers = opts.markers ?? new InMemoryGcMarkerStore()
  const purged: string[] = []
  let now = opts.now ?? 10_000
  const deps: MediaGcDeps = {
    userId: USER,
    listStoredWorkspaceIds: async () => new Set(opts.stored),
    listAccessibleWorkspaceIds: async () => new Set(opts.accessible),
    markers,
    hasUnUploadedBytes: async (ws) => opts.unUploaded?.has(ws) ?? false,
    purgeWorkspace: async (ws) => {
      const ran = opts.purgeRan ?? true
      if (ran) purged.push(ws)
      return ran
    },
    now: () => now,
    graceMs: GRACE,
  }
  return { deps, markers, purged, advance: (ms: number) => (now += ms), setNow: (n: number) => (now = n) }
}

describe('reclaimOrphanedWorkspaces', () => {
  it('is a no-op when the user has no stored bytes', async () => {
    const { deps, purged } = setup({ stored: [], accessible: ['ws-A'] })
    expect(await reclaimOrphanedWorkspaces(deps)).toEqual({
      purged: [],
      pending: [],
      skippedUnUploaded: [],
    })
    expect(purged).toEqual([])
  })

  it('never purges a workspace the user still has access to, and clears its marker', async () => {
    const markers = new InMemoryGcMarkerStore()
    await markers.set({ userId: USER, workspaceId: 'ws-A', firstSeenOrphanedAt: 0 }) // stale
    const { deps, purged } = setup({ stored: ['ws-A'], accessible: ['ws-A'], markers })
    const summary = await reclaimOrphanedWorkspaces(deps)
    expect(purged).toEqual([])
    expect(summary.purged).toEqual([])
    expect(await markers.get(USER, 'ws-A')).toBeNull() // the stale marker was cleared
  })

  it('marks an orphan on first sighting but does NOT purge it (single-sweep transient safety)', async () => {
    const { deps, markers, purged } = setup({ stored: ['ws-gone'], accessible: [] })
    const summary = await reclaimOrphanedWorkspaces(deps)
    expect(purged).toEqual([])
    expect(summary.pending).toEqual(['ws-gone'])
    expect(await markers.get(USER, 'ws-gone')).toMatchObject({ workspaceId: 'ws-gone' })
  })

  it('does not purge while still inside the grace window', async () => {
    const { deps, purged, advance } = setup({ stored: ['ws-gone'], accessible: [] })
    await reclaimOrphanedWorkspaces(deps) // sweep 1: mark
    advance(GRACE - 1) // not yet past grace
    const summary = await reclaimOrphanedWorkspaces(deps) // sweep 2
    expect(purged).toEqual([])
    expect(summary.pending).toEqual(['ws-gone'])
  })

  it('purges an orphan that has been continuously orphaned past the grace window (≥2 sweeps)', async () => {
    const { deps, markers, purged, advance } = setup({ stored: ['ws-gone'], accessible: [] })
    await reclaimOrphanedWorkspaces(deps) // sweep 1: mark
    advance(GRACE) // past grace
    const summary = await reclaimOrphanedWorkspaces(deps) // sweep 2: purge
    expect(purged).toEqual(['ws-gone'])
    expect(summary.purged).toEqual(['ws-gone'])
    expect(await markers.get(USER, 'ws-gone')).toBeNull() // marker cleared after purge
  })

  it('resets the grace clock when an orphan becomes accessible again before grace elapses', async () => {
    // A transient absence (checksum-wipe re-download / membership glitch) must not reclaim.
    const markers = new InMemoryGcMarkerStore()
    const s1 = setup({ stored: ['ws-X'], accessible: [], markers, now: 0 })
    await reclaimOrphanedWorkspaces(s1.deps) // sweep 1: orphaned → marked
    expect(await markers.get(USER, 'ws-X')).not.toBeNull()

    // sweep 2: workspace is back (accessible) → marker cleared
    const s2 = setup({ stored: ['ws-X'], accessible: ['ws-X'], markers, now: 100 })
    await reclaimOrphanedWorkspaces(s2.deps)
    expect(await markers.get(USER, 'ws-X')).toBeNull()

    // sweep 3: orphaned again, but the clock restarted — even long after the original
    // sighting, it is only a first sighting now, so no purge.
    const s3 = setup({ stored: ['ws-X'], accessible: [], markers, now: 10 * GRACE })
    const summary = await reclaimOrphanedWorkspaces(s3.deps)
    expect(summary.purged).toEqual([])
    expect(summary.pending).toEqual(['ws-X'])
  })

  it('defers a past-grace orphan that still holds un-uploaded bytes (sole-copy guard)', async () => {
    const { deps, markers, purged, advance } = setup({
      stored: ['ws-gone'],
      accessible: [],
      unUploaded: new Set(['ws-gone']),
    })
    await reclaimOrphanedWorkspaces(deps) // mark
    advance(GRACE)
    const summary = await reclaimOrphanedWorkspaces(deps)
    expect(purged).toEqual([])
    expect(summary.skippedUnUploaded).toEqual(['ws-gone'])
    expect(await markers.get(USER, 'ws-gone')).not.toBeNull() // marker kept — retry later
  })

  it('keeps the marker when the purge is skipped because another tab owns the lane', async () => {
    const { deps, markers, purged, advance } = setup({
      stored: ['ws-gone'],
      accessible: [],
      purgeRan: false, // runSingleOwner skipped (non-owner tab)
    })
    await reclaimOrphanedWorkspaces(deps)
    advance(GRACE)
    const summary = await reclaimOrphanedWorkspaces(deps)
    expect(purged).toEqual([]) // purgeWorkspace returned false → nothing removed
    expect(summary.pending).toEqual(['ws-gone'])
    expect(await markers.get(USER, 'ws-gone')).not.toBeNull() // retained for a later owner
  })

  it('purges only the orphaned workspace, leaving accessible siblings untouched', async () => {
    const { deps, purged, advance } = setup({
      stored: ['ws-keep', 'ws-gone'],
      accessible: ['ws-keep'],
    })
    await reclaimOrphanedWorkspaces(deps) // mark ws-gone
    advance(GRACE)
    await reclaimOrphanedWorkspaces(deps)
    expect(purged).toEqual(['ws-gone'])
  })

  it('prunes a stale marker whose workspace no longer has stored bytes', async () => {
    const markers = new InMemoryGcMarkerStore()
    await markers.set({ userId: USER, workspaceId: 'ws-cleared', firstSeenOrphanedAt: 0 })
    const { deps } = setup({ stored: ['ws-A'], accessible: ['ws-A'], markers })
    await reclaimOrphanedWorkspaces(deps)
    expect(await markers.get(USER, 'ws-cleared')).toBeNull() // pruned (not in stored)
  })

  it('prunes stale markers even when the user has no stored bytes at all', async () => {
    const markers = new InMemoryGcMarkerStore()
    await markers.set({ userId: USER, workspaceId: 'ws-cleared', firstSeenOrphanedAt: 0 })
    const { deps } = setup({ stored: [], accessible: [], markers })
    await reclaimOrphanedWorkspaces(deps)
    expect(await markers.get(USER, 'ws-cleared')).toBeNull()
  })
})
