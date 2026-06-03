import { describe, expect, it } from 'vitest'
import { decideStagingRow, type LocalRowState } from './reconcile.js'

const noLocal: LocalRowState = { localUpdatedAt: null, hasPendingUpload: false }

describe('decideStagingRow — materializability', () => {
  it('defers when the workspace is not materializable (locked / quarantine)', () => {
    expect(decideStagingRow('defer', 100, noLocal)).toEqual({ kind: 'defer' })
  })

  it('applies with decrypt for an e2ee workspace with the key loaded', () => {
    expect(decideStagingRow('decrypt', 100, noLocal)).toEqual({ kind: 'apply', decrypt: true })
  })

  it('applies with copy-through for a plaintext workspace (no key needed)', () => {
    expect(decideStagingRow('copy', 100, noLocal)).toEqual({ kind: 'apply', decrypt: false })
  })

  it('does NOT defer a plaintext workspace just because it has no key', () => {
    // The bug the doc warns about: "skip any row whose workspace has no WK"
    // would strand plaintext rows forever.
    const action = decideStagingRow('copy', 100, noLocal)
    expect(action.kind).toBe('apply')
  })
})

describe('decideStagingRow — local-edit reconciliation', () => {
  it('skips when an upload is pending for this id (echo will reconcile)', () => {
    const action = decideStagingRow('copy', 999, { localUpdatedAt: 1, hasPendingUpload: true })
    expect(action).toEqual({ kind: 'skip-stale' })
  })

  it('pending upload wins even if the staging row looks newer', () => {
    // hasPendingUpload short-circuits before the stamp comparison.
    const action = decideStagingRow('decrypt', Number.MAX_SAFE_INTEGER, {
      localUpdatedAt: 0,
      hasPendingUpload: true,
    })
    expect(action).toEqual({ kind: 'skip-stale' })
  })

  it('skips when the local row is strictly newer than the staging snapshot', () => {
    const action = decideStagingRow('copy', 100, { localUpdatedAt: 200, hasPendingUpload: false })
    expect(action).toEqual({ kind: 'skip-stale' })
  })

  it('applies when the staging row is newer than the local row', () => {
    const action = decideStagingRow('decrypt', 300, { localUpdatedAt: 200, hasPendingUpload: false })
    expect(action).toEqual({ kind: 'apply', decrypt: true })
  })

  it('skips on equal stamps — first-writer-wins, mirroring the cache gate', () => {
    // Equal ms-stamps are treated as stale, mirroring BlockCache.applyIfNewer's
    // `<=`: a stale in-flight server read can carry DIFFERENT content under the
    // same updated_at. Under Layout B the observer materializes into the
    // persistent SQLite `blocks` table (not just the in-memory cache), so
    // applying an equal-stamp snapshot would overwrite the local edit on disk
    // and resurface it after a reload — the cache gate can't guard that write.
    const action = decideStagingRow('copy', 200, { localUpdatedAt: 200, hasPendingUpload: false })
    expect(action).toEqual({ kind: 'skip-stale' })
  })

  it('applies a first-seen row (no local copy yet)', () => {
    expect(decideStagingRow('decrypt', 50, noLocal)).toEqual({ kind: 'apply', decrypt: true })
  })

  it('defer takes precedence over any local state', () => {
    expect(
      decideStagingRow('defer', 1, { localUpdatedAt: 999, hasPendingUpload: true }),
    ).toEqual({ kind: 'defer' })
  })
})
