// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drive the mount's user + sync-status surface without the data layer. onFirstSync
// is the REAL implementation (the unit under test is whether we gate on it), run
// against the stub db below.
const h = vi.hoisted(() => ({
  runUploadReconcile: vi.fn(async () => {}),
  armUploadDrain: vi.fn(),
  activeUserId: 'u1' as string | null,
  db: { currentStatus: { hasSynced: false }, registerListener: () => () => {} } as unknown,
}))

vi.mock('@/context/repo.js', () => ({ useRepo: () => ({ id: 'repo', user: { id: h.activeUserId } }) }))
vi.mock('@/data/repoProvider.js', () => ({
  getPowerSyncDb: () => h.db,
}))
vi.mock('./assetUpload.js', () => ({
  runUploadReconcile: h.runUploadReconcile,
  armUploadDrain: h.armUploadDrain,
}))

const { MediaUploadReconciler } = await import('./MediaUploadReconciler.js')

afterEach(cleanup)
beforeEach(() => {
  h.runUploadReconcile.mockClear()
  h.armUploadDrain.mockClear()
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

  it('does nothing when no user is active', () => {
    h.activeUserId = null
    render(<MediaUploadReconciler />)
    expect(h.runUploadReconcile).not.toHaveBeenCalled()
  })
})
