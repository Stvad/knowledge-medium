import { describe, expect, it } from 'vitest'
import { decideStagingRow, type LocalRowState } from './reconcile.js'

const noLocal: LocalRowState = {
  localUpdatedAt: null,
  hasPendingUpload: false,
  isOwnSystemMint: false,
}

/** A non-pending local row with the given stamp; `isOwnSystemMint` toggles
 *  whether it's this client's pristine speculative default or a real edit. */
const local = (
  localUpdatedAt: number,
  opts: { pending?: boolean; systemMint?: boolean } = {},
): LocalRowState => ({
  localUpdatedAt,
  hasPendingUpload: opts.pending ?? false,
  isOwnSystemMint: opts.systemMint ?? false,
})

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
    const action = decideStagingRow('copy', 999, local(1, { pending: true }))
    expect(action).toEqual({ kind: 'skip-stale' })
  })

  it('pending upload wins even if the staging row looks newer', () => {
    // hasPendingUpload short-circuits before the stamp comparison.
    const action = decideStagingRow('decrypt', Number.MAX_SAFE_INTEGER, local(0, { pending: true }))
    expect(action).toEqual({ kind: 'skip-stale' })
  })

  it('strict: protects a strictly-newer REAL local edit (replay-safe)', () => {
    // A non-pending, non-system local row strictly newer than the staging
    // snapshot is a just-uploaded edit facing a stale older in-flight delivery.
    // Protect it — overwriting on disk then re-healing via the upload echo is
    // the QuickFind-freeze pattern the canary guards.
    const action = decideStagingRow('copy', 100, local(200))
    expect(action).toEqual({ kind: 'skip-stale' })
  })

  it('strict: a strictly-newer OWN system mint yields to the server (heals)', () => {
    // The pristine speculative default minted on read-as-absent. The server's
    // older-but-authoritative value must win or it shadows real synced config.
    const action = decideStagingRow('copy', 100, local(200, { systemMint: true }))
    expect(action).toEqual({ kind: 'apply', decrypt: false })
  })

  it('healing: a strictly-newer REAL local edit also yields (pre-provenance shadow)', () => {
    // Pre-provenance shadows are stamped with the real user, so strict mode
    // would protect them. The one-time recovery rescan runs in healing mode,
    // where the server wins on any strictly-newer non-pending row.
    const action = decideStagingRow('copy', 100, local(200), 'healing')
    expect(action).toEqual({ kind: 'apply', decrypt: false })
  })

  it('healing still respects the pending-upload guard', () => {
    // Healing relaxes only the strictly-newer branch — an unsent edit is never
    // lost, in either mode.
    const action = decideStagingRow('copy', 100, local(200, { pending: true }), 'healing')
    expect(action).toEqual({ kind: 'skip-stale' })
  })

  it('applies when the staging row is newer than the local row', () => {
    const action = decideStagingRow('decrypt', 300, local(200))
    expect(action).toEqual({ kind: 'apply', decrypt: true })
  })

  it('skips on equal stamps — the one deliberate stamp guard (commit 429fd4b2)', () => {
    // A stale in-flight server read can carry DIFFERENT content under the same
    // updated_at. The observer materializes into the persistent SQLite `blocks`
    // table, so applying an equal-stamp snapshot would overwrite a local edit on
    // disk and resurface it after reload — the cache gate can't guard that.
    // Holds in both modes, and even for an own system mint.
    expect(decideStagingRow('copy', 200, local(200))).toEqual({ kind: 'skip-stale' })
    expect(decideStagingRow('copy', 200, local(200, { systemMint: true })))
      .toEqual({ kind: 'skip-stale' })
    expect(decideStagingRow('copy', 200, local(200), 'healing')).toEqual({ kind: 'skip-stale' })
  })

  it('applies a first-seen row (no local copy yet)', () => {
    expect(decideStagingRow('decrypt', 50, noLocal)).toEqual({ kind: 'apply', decrypt: true })
  })

  it('defer takes precedence over any local state', () => {
    expect(
      decideStagingRow('defer', 1, local(999, { pending: true })),
    ).toEqual({ kind: 'defer' })
  })
})
