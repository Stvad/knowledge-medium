import { describe, expect, it } from 'vitest'
import { looksLikeDbCorruptionForForensics } from './dbForensicsHooks.js'
import { isLocalDbCorruptionError } from './localDbCorruption.js'

describe('looksLikeDbCorruptionForForensics', () => {
  it('matches the open-time phrasings the strict detector matches', () => {
    expect(looksLikeDbCorruptionForForensics(new Error('database disk image is malformed'))).toBe(true)
    expect(looksLikeDbCorruptionForForensics(new Error('file is not a database'))).toBe(true)
  })

  it('ALSO matches the runtime sync-apply phrasing the strict detector misses', () => {
    const runtime = new Error('powersync_control: internal SQLite call returned CORRUPT')
    // Guard: the strict, reset-gating detector must NOT match this (that's the
    // #281 gap) — so the forensics-only broadening is what captures it.
    expect(isLocalDbCorruptionError(runtime)).toBe(false)
    expect(looksLikeDbCorruptionForForensics(runtime)).toBe(true)
  })

  it('does not match benign errors', () => {
    expect(looksLikeDbCorruptionForForensics(new Error('malformed URL'))).toBe(false)
    expect(looksLikeDbCorruptionForForensics(new Error('network request failed'))).toBe(false)
    expect(looksLikeDbCorruptionForForensics(undefined)).toBe(false)
  })
})
