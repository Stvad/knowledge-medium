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
})
