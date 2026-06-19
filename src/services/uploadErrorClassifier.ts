/** Classifies an error thrown during a PowerSync upload attempt as either
 *  recoverable on retry (`transient`) or guaranteed to fail again the
 *  same way (`permanent`).
 *
 *  Permanent rejections are dropped from the upload queue and copied to
 *  `ps_crud_rejected` for inspection; transient errors are re-thrown so
 *  PowerSync retries the batch.
 *
 *  Default for unknown shapes is `transient` — defaulting permanent would
 *  silently drop user data on any error class we haven't seen yet. The
 *  trade-off is that an unfamiliar permanent error keeps jamming the
 *  queue until we add it to the list below; we accept that in exchange
 *  for never losing writes silently. */
export type UploadErrorClass = 'transient' | 'permanent'

const isObjectWith = <K extends string>(
  value: unknown,
  key: K,
): value is Record<K, unknown> =>
  typeof value === 'object' && value !== null && key in value

/** Postgres SQLSTATE classes that can never succeed on retry of the same
 *  payload, so the tx is dropped to the rejection table rather than retried
 *  forever. PostgREST surfaces these on the JS error's `code` field verbatim.
 *   - `22xxx` data exception — a malformed / out-of-range value, e.g. `22P02`
 *     invalid_text_representation from a bad cast of `created_at` /
 *     `updated_at` / `user_updated_at` / `deleted` inside `apply_block_patches`.
 *     Matched class-wide like `23xxx` / `42xxx`: every class-22 path reachable
 *     today is a fixed-payload cast that fails identically on retry. (A future
 *     trigger raising a state-dependent class-22 code would be dropped under
 *     this same class-wide trade — as a cross-client `23505` already is —
 *     rather than jamming the whole queue for every write.)
 *   - `23xxx` integrity-constraint violation (FK / unique / check).
 *   - `42xxx` access-rule / syntax error (RLS GRANT denial, client/server
 *     schema drift).
 *
 *  `P0002` (`no_data_found`) is raised by `apply_block_patches` when a
 *  patch's target row is missing — retrying the same batch cannot make
 *  the missing row reappear, so it belongs in the permanent bucket. */
const PERMANENT_PLPGSQL_SQLSTATES = new Set(['P0002'])

const isPermanentSqlState = (code: string): boolean =>
  code.startsWith('22') ||
  code.startsWith('23') ||
  code.startsWith('42') ||
  PERMANENT_PLPGSQL_SQLSTATES.has(code)

/** PostgREST-specific codes (prefixed `PGRST`) that are permanent — the
 *  request can never succeed unchanged:
 *   - `PGRST204` — column not found in the schema cache (client/server schema
 *     drift); the same payload keeps missing the column until a deploy.
 *   - `PGRST116` — result-cardinality mismatch (`.single()` got 0 or >1 rows).
 *  Keep this list narrow — broaden as new permanent classes surface in logs.
 *
 *  Deliberately NOT here: the JWT/auth group — `PGRST301` ("JWT invalid or
 *  expired") and `PGRST302` ("anonymous access disabled"), both HTTP 401.
 *  Those are RECOVERABLE: the token refreshes or the user re-authenticates and
 *  the retry succeeds, so they fall through to `transient`. Dropping a write on
 *  an expired token is exactly the silent data-loss this module exists to
 *  avoid. A genuine authorization revocation (a workspace un-shared out from
 *  under a pending write → row-level security rejects it) surfaces instead as
 *  the Postgres SQLSTATE `42501` (HTTP 403), which `isPermanentSqlState`
 *  catches — so revoked access is still quarantined, told apart from a
 *  recoverable expired token by the precise CODE rather than the 401/403. */
const PERMANENT_POSTGREST_CODES = new Set(['PGRST204', 'PGRST116'])

/** HTTP statuses that mean "the client sent a request the same payload can
 *  never fix" — retry produces the same response, so the write is dropped to
 *  the rejection table. The retry-friendly 4xx subset is deliberately
 *  excluded so a recoverable failure never silently drops a valid write:
 *    - 408 (timeout) / 429 (rate limit): the server invites a later retry.
 *    - 401 (unauthorized) / 403 (forbidden): an expired or not-yet-refreshed
 *      session, or a gateway-auth blip — recoverable once the token refreshes
 *      or the user re-authenticates, so the queued write must be retried.
 *      Dropping it here would lose a valid edit over a transient credentials
 *      problem. The two auth outcomes are told apart by the error CODE, not
 *      the status: an expired/invalid token carries the JWT code (`PGRST301`,
 *      transient) while a genuine authorization revocation (workspace
 *      un-shared → RLS rejects the write) carries the Postgres SQLSTATE
 *      `42501` and is caught as permanent by the code branch above. Only
 *      codeless status-only auth errors reach here. */
const RETRYABLE_HTTP_STATUSES = new Set([401, 403, 408, 429])

const isPermanentHttpStatus = (status: number): boolean =>
  status >= 400 && status < 500 && !RETRYABLE_HTTP_STATUSES.has(status)

export const classifyUploadError = (err: unknown): UploadErrorClass => {
  // A structured `code` is the precise signal: classify on it and never fall
  // through to the coarse HTTP status. An unrecognized code stays transient by
  // default — we promote codes into the permanent lists above only as we
  // confirm they're unrecoverable. Letting the threaded status override that
  // would drop writes for recoverable code-bearing errors, e.g. PGRST202
  // (stale/missing RPC signature after a migration, surfaced by PostgREST as
  // HTTP 404) which recovers once the schema cache reloads.
  if (isObjectWith(err, 'code') && typeof err.code === 'string') {
    if (isPermanentSqlState(err.code)) return 'permanent'
    if (PERMANENT_POSTGREST_CODES.has(err.code)) return 'permanent'
    return 'transient'
  }

  // Codeless errors only: a non-JSON 4xx body postgrest-js surfaces as
  // `{message: body}` with no `code`, and raw auth/gateway failures carry no
  // code either — so the HTTP status threaded onto the throw is the only
  // signal we have to classify on. (See `throwWithHttpStatus` in powersync.ts
  // and issue #190.)
  if (isObjectWith(err, 'status') && typeof err.status === 'number') {
    if (isPermanentHttpStatus(err.status)) return 'permanent'
  }

  return 'transient'
}
