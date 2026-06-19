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

/** Postgres integrity-constraint class (`23xxx`) and access/syntax class
 *  (`42xxx`) are permanent — retrying with the same payload cannot succeed.
 *  PostgREST surfaces these on the JS error's `code` field verbatim.
 *
 *  `P0002` (`no_data_found`) is raised by `apply_block_patches` when a
 *  patch's target row is missing — retrying the same batch cannot make
 *  the missing row reappear, so it belongs in the permanent bucket. */
const PERMANENT_PLPGSQL_SQLSTATES = new Set(['P0002'])

const isPermanentSqlState = (code: string): boolean =>
  code.startsWith('23') || code.startsWith('42') || PERMANENT_PLPGSQL_SQLSTATES.has(code)

/** PostgREST-specific codes (prefixed `PGRST`) for situations the underlying
 *  Postgres call never reached, e.g. RLS denial expressed as a 4xx response.
 *  Keep this list narrow — broaden as new permanent classes surface in
 *  production logs. */
const PERMANENT_POSTGREST_CODES = new Set(['PGRST301', 'PGRST204', 'PGRST116'])

/** HTTP statuses that mean "the client sent a request the same payload can
 *  never fix" — retry produces the same response, so the write is dropped to
 *  the rejection table. The retry-friendly 4xx subset is deliberately
 *  excluded so a recoverable failure never silently drops a valid write:
 *    - 408 (timeout) / 429 (rate limit): the server invites a later retry.
 *    - 401 (unauthorized) / 403 (forbidden): an expired or not-yet-refreshed
 *      session, or a gateway-auth blip — recoverable once the token refreshes
 *      or the user re-authenticates, so the queued write must be retried.
 *      Dropping it here would lose a valid edit over a transient credentials
 *      problem. Genuine, unrecoverable authorization failures (RLS denial)
 *      arrive with a code (42501 / PGRST301) and are caught by the code
 *      branch above — not here, where only codeless status-only errors land. */
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
