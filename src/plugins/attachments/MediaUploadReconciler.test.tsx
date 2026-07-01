// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drive the mount's user + sync-status surface without the data layer. onFirstSync
// is the REAL implementation (the unit under test is whether we gate on it), run
// against the stub db below.
const h = vi.hoisted(() => ({
  runUploadReconcile: vi.fn(async () => {}),
  armUploadDrain: vi.fn(),
  runUploadRecovery: vi.fn(),
  activeUserId: 'u1' as string | null,
  db: { currentStatus: { hasSynced: false }, registerListener: () => () => {} } as unknown,
}))

vi.mock('@/context/repo.js', () => ({ useRepo: () => ({ id: 'repo' }) }))
vi.mock('@/data/repoProvider.js', () => ({
  getActiveUserId: () => h.activeUserId,
  getPowerSyncDb: () => h.db,
}))
vi.mock('./assetUpload.js', () => ({
  runUploadReconcile: h.runUploadReconcile,
  armUploadDrain: h.armUploadDrain,
  runUploadRecovery: h.runUploadRecovery,
  RECOVERY_SWEEP_INTERVAL_MS: 3 * 60 * 60 * 1000,
  RECOVERY_SWEEP_MAX_ATTEMPTS: 120,
}))

const { MediaUploadReconciler } = await import('./MediaUploadReconciler.js')
const { RECOVERY_SWEEP_INTERVAL_MS, RECOVERY_SWEEP_MAX_ATTEMPTS } = await import('./assetUpload.js')

afterEach(cleanup)
beforeEach(() => {
  h.runUploadReconcile.mockClear()
  h.armUploadDrain.mockClear()
  h.runUploadRecovery.mockClear()
  h.activeUserId = 'u1'
  h.db = { currentStatus: { hasSynced: false }, registerListener: () => () => {} }
})

describe('MediaUploadReconciler', () => {
  it('runs the boot reconcile even when initial sync NEVER settles (offline / never-synced)', () => {
    // onFirstSync never fires for a never-synced db; the reconcile is REQUIRED work
    // (drains a prior session's pending uploads) and must not be gated on it — else
    // those bytes strand for the whole session. Re-gating it would make this 0.
    render(<MediaUploadReconciler />)
    expect(h.runUploadReconcile).toHaveBeenCalledTimes(1)
    expect(h.runUploadReconcile).toHaveBeenCalledWith('u1', expect.anything())
  })

  it('runs the §9 failed-upload recovery at boot (un-sticks a prior session’s failed uploads)', () => {
    render(<MediaUploadReconciler />)
    expect(h.runUploadRecovery).toHaveBeenCalledTimes(1)
    // Boot recovery targets the active user and is must-run + bounded (no coalesce, no
    // bypassBound) — a prior session's failures deserve one guaranteed pass.
    expect(h.runUploadRecovery.mock.calls[0][0]).toBe('u1')
    expect(h.runUploadRecovery.mock.calls[0][1]).toBeUndefined()
  })

  it('recovers on reconnect (online) — coalesced (skip-if-busy), low (default) cap', () => {
    // The frequent trigger: coalesce so an `online` flap across N tabs doesn't queue N
    // sweeps, and NO cap override → the low default bound (a flap can't re-PUT a bad body).
    render(<MediaUploadReconciler />)
    h.runUploadRecovery.mockClear() // ignore the boot call
    window.dispatchEvent(new Event('online'))
    expect(h.runUploadRecovery).toHaveBeenCalledWith('u1', { coalesce: true })
  })

  it('recovers on the slow periodic sweep — coalesced, HIGH cap (the auto-heal window)', () => {
    // Spy setInterval (call-through) and invoke the recovery sweep's callback directly —
    // robust vs advancing fake timers. The sweep bypasses the low bound via a HIGH cap so
    // a freed path / fixed client still auto-heals (§9), and coalesces across tabs.
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    try {
      render(<MediaUploadReconciler />)
      h.runUploadRecovery.mockClear()
      const sweepCall = setIntervalSpy.mock.calls.find(([, ms]) => ms === RECOVERY_SWEEP_INTERVAL_MS)
      expect(sweepCall, 'a recovery sweep interval should be scheduled').toBeDefined()
      ;(sweepCall![0] as () => void)()
      expect(h.runUploadRecovery).toHaveBeenCalledWith('u1', {
        coalesce: true,
        maxRecoveryAttempts: RECOVERY_SWEEP_MAX_ATTEMPTS,
      })
    } finally {
      setIntervalSpy.mockRestore()
    }
  })

  it('does nothing when no user is active', () => {
    h.activeUserId = null
    render(<MediaUploadReconciler />)
    expect(h.runUploadReconcile).not.toHaveBeenCalled()
    expect(h.runUploadRecovery).not.toHaveBeenCalled()
  })
})
