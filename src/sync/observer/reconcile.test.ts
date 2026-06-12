import { describe, expect, it } from 'vitest'
import { decideStagingRow, type LocalRowState } from './reconcile.js'

const noLocal: LocalRowState = {
  localUpdatedAt: null,
  hasPendingUpload: false,
}

/** A non-pending local row with the given row-version stamp. */
const local = (
  localUpdatedAt: number,
  opts: { pending?: boolean } = {},
): LocalRowState => ({
  localUpdatedAt,
  hasPendingUpload: opts.pending ?? false,
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

  it('applies the server row over a strictly-newer NON-pending local row', () => {
    // No more strictly-newer protection: with server-enforced monotonicity, a
    // genuinely-newer local edit is either pending (caught above) or acked, and
    // its echo (server stamp >= local) re-asserts it. A strictly-older delivery
    // here is an in-flight replay; applying it is a transient revert that the
    // echo converges. The only deliberate hold is the equal-nonzero guard below.
    const action = decideStagingRow('copy', 100, local(200))
    expect(action).toEqual({ kind: 'apply', decrypt: false })
  })

  it('applies when the staging row is newer than the local row', () => {
    const action = decideStagingRow('decrypt', 300, local(200))
    expect(action).toEqual({ kind: 'apply', decrypt: true })
  })

  it('skips on equal NONZERO stamps — the one deliberate stamp guard (commit 429fd4b2)', () => {
    // Equal nonzero stamps ⟺ identical content (the server floor+bump strictly
    // advances the stamp on any content change). A stale in-flight server read
    // carrying DIFFERENT content under the same ms-stamp would otherwise clobber
    // a local edit on the persistent `blocks` table and resurface after reload.
    expect(decideStagingRow('copy', 200, local(200))).toEqual({ kind: 'skip-stale' })
  })

  it('applies on equal ZERO stamps — the stamp-0 exemption (I2)', () => {
    // Two devices that minted the same deterministic id both sit at 0. Without
    // the exemption the insert-or-skip loser would equal-stamp-skip forever and
    // never converge to the server's created_at / created_by / user_updated_at
    // (or content). A 0-stamped pristine local row always yields to the server.
    expect(decideStagingRow('copy', 0, local(0))).toEqual({ kind: 'apply', decrypt: false })
  })

  it('applies a nonzero server row over a 0-stamped pristine local default', () => {
    expect(decideStagingRow('copy', 500, local(0))).toEqual({ kind: 'apply', decrypt: false })
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
