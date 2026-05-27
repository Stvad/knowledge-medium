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

/** HTTP statuses that mean "client made a bad request" — retry will produce
 *  the same response. 408 (timeout) and 429 (rate limit) are deliberately
 *  excluded: the server is inviting a later retry. */
const isPermanentHttpStatus = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 408 && status !== 429

export const classifyUploadError = (err: unknown): UploadErrorClass => {
  if (isObjectWith(err, 'code') && typeof err.code === 'string') {
    if (isPermanentSqlState(err.code)) return 'permanent'
    if (PERMANENT_POSTGREST_CODES.has(err.code)) return 'permanent'
  }

  if (isObjectWith(err, 'status') && typeof err.status === 'number') {
    if (isPermanentHttpStatus(err.status)) return 'permanent'
  }

  return 'transient'
}
