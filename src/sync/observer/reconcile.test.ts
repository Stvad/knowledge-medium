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

  it('applies even when the local row is strictly newer (non-pending → server wins)', () => {
    // A non-pending local row that differs from the server is NOT a local edit
    // (PowerSync's model: server-authoritative-except-pending) — it's a
    // speculative bootstrap default minted with a fresh `now` stamp, or a
    // dropped upload. The server's older-but-authoritative value must win, or it
    // shadows real synced config on every fresh client. Only `hasPendingUpload`
    // (a genuine local edit) or an equal stamp protects the local row.
    const action = decideStagingRow('copy', 100, { localUpdatedAt: 200, hasPendingUpload: false })
    expect(action).toEqual({ kind: 'apply', decrypt: false })
  })

  it('applies when the staging row is newer than the local row', () => {
    const action = decideStagingRow('decrypt', 300, { localUpdatedAt: 200, hasPendingUpload: false })
    expect(action).toEqual({ kind: 'apply', decrypt: true })
  })

  it('skips on equal stamps — the one deliberate stamp guard (commit 429fd4b2)', () => {
    // A stale in-flight server read can carry DIFFERENT content under the same
    // updated_at. The observer materializes into the persistent SQLite `blocks`
    // table, so applying an equal-stamp snapshot would overwrite a local edit on
    // disk and resurface it after reload — the cache gate can't guard that.
    const action = decideStagingRow('copy', 200, { localUpdatedAt: 200, hasPendingUpload: false })
    expect(action).toEqual({ kind: 'skip-stale' })
  })

  it('a pending upload still wins over a strictly-older staging row', () => {
    // The pending guard is the genuine-local-edit signal; it must short-circuit
    // before the (now relaxed) stamp comparison so an unsent edit is never lost.
    const action = decideStagingRow('copy', 100, { localUpdatedAt: 200, hasPendingUpload: true })
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
