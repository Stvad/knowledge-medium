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
// case-insensitively. Each entry is the SPECIFIC SQLite phrasing, not a bare
// token: a routing decision here can lead the user to a DESTRUCTIVE reset, so a
// benign "malformed URL" / "malformed JSON" surfacing during init must NOT match
// (the bare token `malformed` would). The two "malformed" entries are the only
// such emits from SQLite (`SQLITE_CORRUPT`). `sqlite call returned corrupt` is
// the RUNTIME shape: PowerSync's `powersync_control` surfacing SQLITE_CORRUPT
// during sync-apply ("powersync_control: internal SQLite call returned CORRUPT")
// — the class that opens fine but corrupts an already-mounted DB (issue #284).
const CORRUPTION_SUBSTRINGS = [
  'disk image is malformed', // "database disk image is malformed"
  'malformed database schema', // "malformed database schema (...)"
  'not a database', // SQLITE_NOTADB: "file is not a database" / "...or is not a database"
  'database corruption',
  'sqlite_corrupt',
  'sqlite_notadb',
  'sqlite call returned corrupt', // powersync_control surfacing SQLITE_CORRUPT at runtime
] as const

// A TIGHTER set for the RUNTIME sync-apply path (`isRuntimeDbCorruptionError`),
// where `error` is PowerSync's `downloadError`. That field holds ANY sync-loop
// exception — including `HTTP <status>: <raw server body>` — and crosses the
// worker as a plain object, so the broad set above would let a benign server
// error body that merely echoes generic English like "…not a database table…"
// or "malformed … schema" (sync-rule validation) route the user into the
// DESTRUCTIVE recovery UI. These two phrasings are what a real SQLite corruption
// emits AND cannot plausibly appear in the sync API's (Postgres-backed) error
// bodies. `disk image is malformed` is SQLite-only; `sqlite call returned
// corrupt` is powersync_control's exact SQLITE_CORRUPT wrapper.
const RUNTIME_CORRUPTION_SUBSTRINGS = [
  'sqlite call returned corrupt',
  'disk image is malformed',
] as const

// A revoked Proxy throws (TypeError) for EVERY internal trap — `[[Get]]`,
// `[[GetPrototypeOf]]`, `[[Has]]`, all of them — not just string
// conversion. This module reads `error`/`cause` (both `unknown`, with no
// guarantee about what crosses the DB-open / worker boundary) via
// `instanceof` and direct property access all over the functions below, so
// EVERY one of those reads needs the same guard `safeString` needed, or a
// hostile `error` can throw from a completely different line than the one
// originally reported. Two small helpers centralize that:
//  - `safeInstanceOf` guards the `[[GetPrototypeOf]]` walk `instanceof` does.
//  - `safeGet` guards the `[[Get]]` a plain property read does.
// Both fail closed (return `false` / `undefined`), which is exactly what an
// absent/non-matching property would already mean to every caller below.
const safeInstanceOf = (value: unknown, ctor: abstract new (...args: never[]) => unknown): boolean => {
  try {
    return value instanceof ctor
  } catch {
    return false
  }
}

const safeGet = (obj: object, key: PropertyKey): unknown => {
  try {
    return (obj as Record<PropertyKey, unknown>)[key]
  } catch {
    return undefined
  }
}

// `String(x)` throws "Cannot convert object to primitive value" for a
// null-prototype object (`Object.create(null)`, or anything else with no
// reachable `toString`/`valueOf`/`Symbol.toPrimitive`) — there's no
// guarantee what crosses the DB-open / worker boundary, and this module's
// whole job is to classify that value without ever throwing itself.
// `Object.prototype.toString.call` is invoked explicitly rather than
// resolved through the value's own prototype chain, so it can't fail the
// same way for a null-prototype object; it matches what `String(x)` would
// have returned for any ordinary object anyway ("[object Object]").
//
// But that fallback can ALSO throw: a revoked Proxy's `[[Get]]` trap throws
// for every property access, including `Symbol.toStringTag`, which
// `Object.prototype.toString` reads — and the same happens for any object
// whose `Symbol.toStringTag` getter itself throws. Both shapes make
// `String(x)` throw too (it resolves to the inherited
// `Object.prototype.toString` when there's no own `toString`/`valueOf`),
// so they'd reach this catch and throw a SECOND time. The final fallback
// is a fixed string with no further property access on `error`, so this
// function is total no matter how hostile `error` is.
const safeString = (error: unknown): string => {
  try {
    return String(error)
  } catch {
    try {
      return Object.prototype.toString.call(error)
    } catch {
      return '[unstringifiable error]'
    }
  }
}

const messageOf = (error: unknown): string => {
  // `safeInstanceOf` only guards the `[[GetPrototypeOf]]` walk `instanceof`
  // does — it says nothing about the `[[Get]]` trap a SUBSEQUENT direct
  // `.message` read invokes. A proxy that forwards `getPrototypeOf` (so
  // `instanceof Error` succeeds) but throws from `get` for `message` passes
  // this check and then throws on the very next line — the exact totality
  // gap PR #447 review comment 3676752542 found. Route the read through
  // `safeGet` like every other property read on a not-necessarily-honest
  // `error` in this module.
  if (safeInstanceOf(error, Error)) {
    const msg = safeGet(error, 'message')
    if (typeof msg === 'string') return msg
    return safeString(error)
  }
  // A worker/Comlink-serialized error arrives as a plain object; read its string
  // `.message` so the recovery UI's detail shows the real text, not "[object Object]".
  if (typeof error === 'object' && error !== null) {
    const msg = safeGet(error, 'message')
    if (typeof msg === 'string') return msg
  }
  return safeString(error)
}

// The SQLite corruption text doesn't always reach us on the top-level `.message`
// — PowerSync/app layers can rethrow with a generic outer message and the real
// error on `.cause` (e.g. `new Error('boot failed', { cause: sqliteError })`).
// Concatenate the whole cause chain (bounded) so substring-matching sees it.
//
// A non-Error is handled too: an error that crosses a Web Worker / Comlink
// boundary can arrive as a PLAIN OBJECT `{name, message, stack}` rather than a
// real `Error` instance — PowerSync's runtime `downloadError` (thrown by the
// wa-sqlite worker's `powersync_control`) is exactly this shape. Reading its
// string `.message` (instead of `String(obj)` → "[object Object]") is what lets
// the runtime-corruption routing match at all.
const messageChainOf = (error: unknown, depth = 5): string => {
  if (depth <= 0 || error === null || error === undefined) return ''
  if (safeInstanceOf(error, Error)) {
    const err = error as Error
    // Same guard as `messageOf`: `instanceof` confirms the prototype chain,
    // not that a direct `.message`/`.cause` read is safe — both go through
    // `safeGet` (PR #447 review comment 3676752542).
    const msg = safeGet(err, 'message')
    const message = typeof msg === 'string' ? msg : safeString(error)
    const cause = safeGet(err, 'cause')
    return cause === undefined
      ? message
      : `${message}\n${messageChainOf(cause, depth - 1)}`
  }
  if (typeof error === 'object') {
    const msg = safeGet(error, 'message')
    if (typeof msg === 'string') {
      const cause = safeGet(error, 'cause')
      return cause === undefined
        ? msg
        : `${msg}\n${messageChainOf(cause, depth - 1)}`
    }
  }
  return safeString(error)
}

const includesAnySubstring = (error: unknown, substrings: readonly string[]): boolean => {
  const msg = messageChainOf(error).toLowerCase()
  return substrings.some(s => msg.includes(s))
}

/** True when `error` reads like an unrecoverable SQLite-corruption open failure.
 *  Use at the DB-OPEN boundary, where `error` is a real in-process Error (no
 *  worker-boundary / server-body contamination). For the runtime `downloadError`
 *  path use {@link isRuntimeDbCorruptionError}, which is narrower. */
export const isLocalDbCorruptionError = (error: unknown): boolean =>
  includesAnySubstring(error, CORRUPTION_SUBSTRINGS)

/** True when a RUNTIME sync-apply `downloadError` is a genuine SQLite corruption
 *  — tighter than {@link isLocalDbCorruptionError} so a server-controlled error
 *  body can't route a healthy session into the destructive recovery UI (see
 *  RUNTIME_CORRUPTION_SUBSTRINGS). */
export const isRuntimeDbCorruptionError = (error: unknown): boolean =>
  includesAnySubstring(error, RUNTIME_CORRUPTION_SUBSTRINGS)

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
  // A non-empty userId is required: downstream resolves the OPFS `.db` from it
  // (`dbFilenameForUser('')` → `kmp-v6-.db`), so an empty id would back up /
  // delete the wrong file. Fall through to the generic boundary instead.
  if (safeInstanceOf(error, LocalDatabaseCorruptError)) {
    const userId = safeGet(error as object, 'userId')
    return typeof userId === 'string' && userId.length > 0 ? userId : null
  }
  if (typeof error === 'object' && error !== null) {
    const name = safeGet(error, 'name')
    const userId = safeGet(error, 'userId')
    if (name === 'LocalDatabaseCorruptError' && typeof userId === 'string' && userId.length > 0) {
      return userId
    }
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
