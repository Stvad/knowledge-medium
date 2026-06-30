import { describe, expect, it } from 'vitest'
import {
  LocalDatabaseCorruptError,
  corruptErrorUserId,
  isLocalDbCorruptionError,
  toLocalDbOpenError,
} from './localDbCorruption'

describe('isLocalDbCorruptionError', () => {
  it('matches the SQLite corruption messages we actually see on open', () => {
    for (const msg of [
      'database disk image is malformed',
      'malformed database schema (blocks_fts_update) - trigger blocks_fts_update already exists',
      'file is not a database',
      'file is encrypted or is not a database',
      'SQLITE_CORRUPT: database disk image is malformed',
    ]) {
      expect(isLocalDbCorruptionError(new Error(msg)), msg).toBe(true)
    }
  })

  it('does NOT match transient / unrelated open failures', () => {
    for (const msg of [
      'database is locked',
      'SQLITE_BUSY: database is busy',
      'no such table: blocks',
      'This browser is blocking local storage access (OPFS)',
      'NetworkError when attempting to fetch resource',
    ]) {
      expect(isLocalDbCorruptionError(new Error(msg)), msg).toBe(false)
    }
  })

  it('does NOT match a benign "malformed X" that is not SQLite corruption', () => {
    // The substring list must be the specific SQLite phrasings, not a bare
    // `malformed` — otherwise a malformed-URL/JSON/UTF-8 error surfacing during
    // init would route the user to a DESTRUCTIVE reset for a healthy DB.
    for (const msg of [
      'Failed to construct URL: malformed input',
      'SyntaxError: malformed JSON response',
      'malformed UTF-8 data',
    ]) {
      expect(isLocalDbCorruptionError(new Error(msg)), msg).toBe(false)
    }
  })

  it('walks the cause chain so corruption wrapped behind a generic message still matches', () => {
    const wrapped = new Error('Failed to initialize database', {
      cause: new Error('database disk image is malformed'),
    })
    expect(isLocalDbCorruptionError(wrapped)).toBe(true)
    // ...but a generic error with a benign cause still does not match.
    const benign = new Error('boot failed', { cause: new Error('network down') })
    expect(isLocalDbCorruptionError(benign)).toBe(false)
  })

  it('handles non-Error values', () => {
    expect(isLocalDbCorruptionError('database disk image is malformed')).toBe(true)
    expect(isLocalDbCorruptionError(null)).toBe(false)
    expect(isLocalDbCorruptionError(undefined)).toBe(false)
  })
})

describe('toLocalDbOpenError', () => {
  it('wraps a corruption error, carrying userId + the original as cause', () => {
    const original = new Error('database disk image is malformed')
    const wrapped = toLocalDbOpenError(original, 'user-123')
    expect(wrapped).toBeInstanceOf(LocalDatabaseCorruptError)
    expect((wrapped as LocalDatabaseCorruptError).userId).toBe('user-123')
    expect((wrapped as LocalDatabaseCorruptError).cause).toBe(original)
  })

  it('passes a non-corruption error through unchanged', () => {
    const original = new Error('database is locked')
    expect(toLocalDbOpenError(original, 'user-123')).toBe(original)
  })

  it('is idempotent on an already-wrapped error (no double-wrap)', () => {
    const wrapped = new LocalDatabaseCorruptError('user-123', { cause: new Error('malformed') })
    expect(toLocalDbOpenError(wrapped, 'user-456')).toBe(wrapped)
  })
})

describe('corruptErrorUserId', () => {
  it('returns the userId for a wrapped error', () => {
    expect(corruptErrorUserId(new LocalDatabaseCorruptError('u1'))).toBe('u1')
  })

  it('recognises a structurally-equal error across instanceof boundaries', () => {
    // Simulates an HMR/bundle boundary where the class identity differs.
    const lookalike = { name: 'LocalDatabaseCorruptError', userId: 'u2', message: 'x' }
    expect(corruptErrorUserId(lookalike)).toBe('u2')
  })

  it('returns null for unrelated errors', () => {
    expect(corruptErrorUserId(new Error('boom'))).toBeNull()
    expect(corruptErrorUserId(null)).toBeNull()
  })

  it('rejects an empty userId (would resolve the wrong OPFS file)', () => {
    expect(corruptErrorUserId(new LocalDatabaseCorruptError(''))).toBeNull()
    expect(
      corruptErrorUserId({ name: 'LocalDatabaseCorruptError', userId: '', message: 'x' }),
    ).toBeNull()
  })
})
