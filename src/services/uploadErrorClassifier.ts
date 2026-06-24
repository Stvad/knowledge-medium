/** Classifies an error thrown during a PowerSync upload attempt into one of
 *  three outcomes that drive the upload orchestrator:
 *
 *   - `transient`  — recoverable; re-thrown so PowerSync retries the batch.
 *                    Network/offline, 5xx, rate-limit/timeout, an expired or
 *                    not-yet-refreshed session, and any shape we don't
 *                    recognise default here: retrying is always safe, and a
 *                    stuck transient is visible (the queue stops draining) and
 *                    self-heals when the condition clears.
 *   - `permanent`  — a precise signal that the same payload can never succeed
 *                    (an integrity/data/syntax SQLSTATE, or a malformed-request
 *                    PostgREST code). Quarantined to `ps_crud_rejected`
 *                    immediately so the rest of the queue keeps draining.
 *   - `ambiguous`  — a suspected-permanent client error (a 4xx) we CANNOT
 *                    confirm from a known code. The orchestrator retries it a
 *                    bounded number of times (absorbing a transient blip) and
 *                    quarantines it only if it still won't clear — so we
 *                    neither jam the queue forever on a real permanent error
 *                    nor drop a write that was only briefly 4xx.
 *
 *  Quarantine is NOT silent data loss: a rejected tx is recorded to
 *  `ps_crud_rejected` and surfaced to the user. The bias is still away from
 *  dropping a recoverable write — only a *precise* permanent signal drops
 *  immediately; everything uncertain is retried first, and anything that looks
 *  like infrastructure being down (no code, no 4xx) is retried indefinitely. */
export type UploadErrorClass = 'transient' | 'permanent' | 'ambiguous'

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
 *  request can never succeed unchanged. Kept narrow; anything not listed that
 *  still looks like a client error (a 4xx) is caught as `ambiguous`
 *  (retry-budget) rather than dropped, so under-listing only delays a
 *  quarantine, it never jams forever.
 *   - `PGRST100` / `PGRST101` / `PGRST102` / `PGRST103` — malformed request
 *     (query-string parse, wrong method, invalid body, invalid range). Our
 *     upload sends fixed-shape `rpc` / `upsert` / `delete` requests, so these
 *     only arise from a client bug, which retrying cannot fix.
 *   - `PGRST204` — column not found in the schema cache (client/server drift).
 *   - `PGRST116` — result-cardinality mismatch (`.single()` got 0 or >1 rows). */
const PERMANENT_POSTGREST_CODES = new Set([
  'PGRST100',
  'PGRST101',
  'PGRST102',
  'PGRST103',
  'PGRST204',
  'PGRST116',
])

/** PostgREST codes that are RECOVERABLE — retry forever, never quarantine:
 *   - `PGRST301` ("JWT invalid or expired") / `PGRST302` ("anonymous access
 *     disabled"), both HTTP 401: the token refreshes or the user
 *     re-authenticates and the retry succeeds. Dropping a write on an expired
 *     token is exactly the silent data-loss this module exists to avoid; a
 *     genuine authorization revocation (a workspace un-shared out from under a
 *     pending write) surfaces as the Postgres SQLSTATE `42501` instead — told
 *     apart by the precise CODE, not the coarse 401/403.
 *   - `PGRST202` ("function not found" — a stale RPC signature after a
 *     migration, surfaced as HTTP 404): self-heals once PostgREST reloads its
 *     schema cache, so it must be retried, not quarantined. */
const RECOVERABLE_POSTGREST_CODES = new Set(['PGRST301', 'PGRST302', 'PGRST202'])

/** HTTP 4xx statuses that are RECOVERABLE (retry forever) rather than a
 *  suspected-permanent client error:
 *    - 408 (timeout) / 429 (rate limit): the server invites a later retry.
 *    - 401 (unauthorized) / 403 (forbidden): an expired / not-yet-refreshed
 *      session or a gateway-auth blip — recoverable once the token refreshes or
 *      the user re-authenticates. (A real authorization revocation carries the
 *      SQLSTATE `42501`, caught as permanent by the code branch.) */
const RETRYABLE_HTTP_STATUSES = new Set([401, 403, 408, 429])

const isClientErrorStatus = (status: number): boolean => status >= 400 && status < 500

export const classifyUploadError = (err: unknown): UploadErrorClass => {
  // 1. A structured code we recognise is the precise signal — classify on it
  //    and never let the coarse HTTP status override it.
  if (isObjectWith(err, 'code') && typeof err.code === 'string' && err.code !== '') {
    if (isPermanentSqlState(err.code)) return 'permanent'
    if (PERMANENT_POSTGREST_CODES.has(err.code)) return 'permanent'
    if (RECOVERABLE_POSTGREST_CODES.has(err.code)) return 'transient'
    // An unrecognised code falls through to the status buckets below. A 4xx
    // becomes `ambiguous` (retry-budget) — not an immediate drop (which would
    // lose a recoverable code we haven't catalogued yet, e.g. a new
    // self-healing PGRST class) and not the old infinite jam.
  }

  // 2. Codeless / unrecognised-code errors: the HTTP status threaded onto the
  //    throw (see `throwWithHttpStatus` in powersync.ts, issue #190) is the
  //    only signal. A 4xx is a suspected client error — the retry-friendly
  //    subset retries forever, the rest is `ambiguous` (retry-budget then
  //    quarantine).
  if (
    isObjectWith(err, 'status') &&
    typeof err.status === 'number' &&
    isClientErrorStatus(err.status)
  ) {
    return RETRYABLE_HTTP_STATUSES.has(err.status) ? 'transient' : 'ambiguous'
  }

  // 3. No code we recognise and no 4xx: network/offline (a thrown fetch error,
  //    or postgrest-js's `status: 0`), a 5xx, or a shape we've never seen. All
  //    retry forever — never quarantine a write over infrastructure being down.
  return 'transient'
}
