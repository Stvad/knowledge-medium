// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drive the mount's repo / active-workspace / user surface without the data layer,
// and stub the down-lane wiring so the test pins the ARMING, not the pass itself.
const h = vi.hoisted(() => ({
  repo: { id: 'repo', user: { id: 'u1' } } as unknown,
  workspaceId: 'ws-1' as string | null,
  runDownLaneReconcile: vi.fn(async () => {}),
  // The settle callback the component registers via onFirstSync — captured so a test
  // can fire it (the "re-run once initial sync settles" path).
  settleCallback: null as null | (() => void),
}))

vi.mock('@/context/repo.js', () => ({ useRepo: () => h.repo }))
vi.mock('@/hooks/useWorkspaces.js', () => ({ useActiveWorkspaceId: () => h.workspaceId }))
vi.mock('@/data/repoProvider.js', () => ({
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
  h.repo = { id: 'repo', user: { id: 'u1' } }
  h.workspaceId = 'ws-1'
  h.runDownLaneReconcile.mockClear()
  h.settleCallback = null
})

describe('MediaDownLaneReplicator', () => {
  it('runs a down-lane pass for the active workspace (off the cold-start window)', async () => {
    render(<MediaDownLaneReplicator />)
    await flushIdle()
    expect(h.runDownLaneReconcile).toHaveBeenCalledWith(h.repo, 'ws-1')
  })

  it('re-runs once initial sync settles — but OFF the hot path (idle-deferred, not synchronous)', async () => {
    render(<MediaDownLaneReplicator />)
    await flushIdle() // drain the initial catch-up pass
    expect(h.settleCallback).toBeTypeOf('function') // registered with onFirstSync
    h.runDownLaneReconcile.mockClear()

    // onFirstSync fires the settle callback SYNCHRONOUSLY when already synced (e.g. a
    // workspace switch); the pass must NOT run inline on that navigation path.
    act(() => h.settleCallback?.())
    expect(h.runDownLaneReconcile).not.toHaveBeenCalled()

    await flushIdle()
    expect(h.runDownLaneReconcile).toHaveBeenCalledWith(h.repo, 'ws-1')
  })

  it('coalesces overlapping triggers into ONE pass (no double-walk on a workspace switch)', async () => {
    // The switch arms the initial catch-up AND onFirstSync fires the settle synchronously
    // before either idle window runs — both must collapse to a single pass.
    render(<MediaDownLaneReplicator />)
    act(() => h.settleCallback?.())
    await flushIdle()
    expect(h.runDownLaneReconcile).toHaveBeenCalledTimes(1)
  })

  it('does NOT run a pass without an active workspace', async () => {
    h.workspaceId = null
    render(<MediaDownLaneReplicator />)

    await flushIdle()
    expect(h.runDownLaneReconcile).not.toHaveBeenCalled()
  })
})
