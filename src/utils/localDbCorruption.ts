/**
 * Detect an unrecoverable local-database open failure (SQLite corruption) and
 * carry it to the error boundary as a typed, recoverable error.
 *
 * Why a dedicated type: the bootstrap error boundary needs to tell "the local
 * SQLite file is structurally broken" (offer Export + Reset) apart from any
 * other bootstrap failure (offer only Reload / Sign out). It also needs the
 * `userId` to locate the OPFS `.db` file, which isn't on the raw SQLite error.
 *
 * This module is intentionally dependency-free (no repoProvider import) so the
 * DB-open path can import it without a cycle.
 */

// Substrings SQLite/PowerSync surface when the `.db` bytes can't be opened
// because they're structurally invalid — NOT transient (busy/locked) and NOT
// access-denied (private-browsing OPFS block, handled separately). Matched
// case-insensitively against the error message. Kept narrow on purpose: this
// only runs at the DB-open boundary, where every error is database-related.
const CORRUPTION_SUBSTRINGS = [
  'malformed', // "database disk image is malformed", "malformed database schema"
  'not a database', // SQLITE_NOTADB: "file is not a database" / "...or is not a database"
  'database corruption',
  'sqlite_corrupt',
  'sqlite_notadb',
] as const

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** True when `error` reads like an unrecoverable SQLite-corruption open failure. */
export const isLocalDbCorruptionError = (error: unknown): boolean => {
  const msg = messageOf(error).toLowerCase()
  return CORRUPTION_SUBSTRINGS.some(s => msg.includes(s))
}

/**
 * Typed local-DB corruption error. Carries the `userId` so the recovery UI can
 * resolve the OPFS `.db` file, and the original error as `cause`.
 */
export class LocalDatabaseCorruptError extends Error {
  readonly userId: string

  constructor(userId: string, options?: { cause?: unknown }) {
    const cause = options?.cause
    super(`Local database is corrupted and could not be opened: ${messageOf(cause)}`)
    this.name = 'LocalDatabaseCorruptError'
    this.userId = userId
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Recognise a `LocalDatabaseCorruptError` even across HMR / bundle boundaries
 * where `instanceof` can fail (the class identity differs). Returns the wrapped
 * userId, or `null` if `error` isn't a wrapped corruption error.
 */
export const corruptErrorUserId = (error: unknown): string | null => {
  if (error instanceof LocalDatabaseCorruptError) return error.userId
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'LocalDatabaseCorruptError' &&
    typeof (error as { userId?: unknown }).userId === 'string'
  ) {
    return (error as { userId: string }).userId
  }
  return null
}

/**
 * Use at the DB-open boundary: returns a typed `LocalDatabaseCorruptError` (to
 * throw) when `error` is a corruption failure, otherwise returns `error`
 * unchanged so the caller can rethrow it as-is. Idempotent on an
 * already-wrapped error.
 */
export const toLocalDbOpenError = (error: unknown, userId: string): unknown => {
  if (corruptErrorUserId(error) !== null) return error
  if (isLocalDbCorruptionError(error)) return new LocalDatabaseCorruptError(userId, { cause: error })
  return error
}
