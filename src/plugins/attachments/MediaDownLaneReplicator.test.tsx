// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drive the mount's repo / active-workspace / user surface without the data layer,
// and stub the down-lane wiring so the test pins the ARMING, not the pass itself.
const h = vi.hoisted(() => ({
  repo: { id: 'repo' } as unknown,
  workspaceId: 'ws-1' as string | null,
  userId: 'u1' as string | null,
  runDownLaneReconcile: vi.fn(async () => {}),
  // The settle callback the component registers via onFirstSync — captured so a test
  // can fire it (the "re-run once initial sync settles" path).
  settleCallback: null as null | (() => void),
}))

vi.mock('@/context/repo.js', () => ({ useRepo: () => h.repo }))
vi.mock('@/hooks/useWorkspaces.js', () => ({ useActiveWorkspaceId: () => h.workspaceId }))
vi.mock('@/data/repoProvider.js', () => ({
  getActiveUserId: () => h.userId,
  getPowerSyncDb: () => ({}),
}))
vi.mock('@/data/internals/firstSync.js', () => ({
  onFirstSync: (_db: unknown, settle: () => void) => {
    h.settleCallback = settle
    return () => {}
  },
}))
vi.mock('./assetDownLane.js', () => ({
  DOWN_LANE_SWEEP_INTERVAL_MS: 600_000,
  runDownLaneReconcile: h.runDownLaneReconcile,
}))

const { MediaDownLaneReplicator } = await import('./MediaDownLaneReplicator.js')

// scheduleDeepIdle has no requestIdleCallback under jsdom → setTimeout(fn, 0); flush it.
const flushIdle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

afterEach(cleanup)
beforeEach(() => {
  h.repo = { id: 'repo' }
  h.workspaceId = 'ws-1'
  h.userId = 'u1'
  h.runDownLaneReconcile.mockClear()
  h.settleCallback = null
})

describe('MediaDownLaneReplicator', () => {
  it('runs a down-lane pass for the active workspace (off the cold-start window)', async () => {
    render(<MediaDownLaneReplicator />)
    await flushIdle()
    expect(h.runDownLaneReconcile).toHaveBeenCalledWith(h.repo, 'ws-1')
  })

  it('re-runs the pass once initial sync settles', async () => {
    render(<MediaDownLaneReplicator />)
    expect(h.settleCallback).toBeTypeOf('function') // registered with onFirstSync

    h.runDownLaneReconcile.mockClear()
    act(() => h.settleCallback?.())
    expect(h.runDownLaneReconcile).toHaveBeenCalledWith(h.repo, 'ws-1')
  })

  it('does NOT run a pass without an active workspace', async () => {
    h.workspaceId = null
    render(<MediaDownLaneReplicator />)

    await flushIdle()
    expect(h.runDownLaneReconcile).not.toHaveBeenCalled()
  })
})
