import { describe, expect, it } from 'vitest'
import { isSystemAuthor, systemAuthor } from './user'

describe('system author', () => {
  // The namespace-safety property the whole provenance fix rests on: a
  // real user id (opaque UUID) must never read as a system author, and an
  // engine mint must always read back as one. The exact prefix string is
  // an implementation detail not worth restating; these two invariants are
  // the contract the reconcile gate and display surfaces depend on.
  it('round-trips a minted author and rejects a real user id', () => {
    const userId = '99b1b4e5-6f58-4fd2-9089-dc3b358dd4df'
    expect(isSystemAuthor(systemAuthor(userId))).toBe(true)
    expect(isSystemAuthor(userId)).toBe(false)
  })

  it('carries the originating user id so the mint stays attributable', () => {
    // The derived-per-user design (vs a single global sentinel) exists so
    // a mint remains traceable to the client that wrote it. Two users mint
    // distinguishable authors for the same logical default.
    expect(systemAuthor('alice')).not.toBe(systemAuthor('bob'))
    expect(systemAuthor('alice').endsWith('alice')).toBe(true)
  })

  it('does not treat an empty author as a system author', () => {
    // `skipMetadata` writes leave `updated_by` as '' — that's a bookkeeping
    // write, not a system mint, and must not be mistaken for one.
    expect(isSystemAuthor('')).toBe(false)
  })
})
