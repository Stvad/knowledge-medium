import { describe, expect, it } from 'vitest'
import { classifyUploadError } from './uploadErrorClassifier'

/** Synthesizes a PostgrestError-shaped object. The real class lives in
 *  @supabase/postgrest-js but we test against the structural shape the
 *  classifier inspects (`code`, `message`) so we don't have to import
 *  the runtime class for every test row. */
const postgrestError = (code: string, message = 'test'): Error => {
  const err = new Error(message)
  ;(err as Error & {code: string}).code = code
  return err
}

const httpError = (status: number, message = 'test'): Error => {
  const err = new Error(message)
  ;(err as Error & {status: number}).status = status
  return err
}

describe('classifyUploadError', () => {
  describe('Postgres SQLSTATE codes', () => {
    it('classifies 22xxx data exceptions as permanent', () => {
      // 22P02 = invalid_text_representation (a malformed cast of e.g.
      // created_at/updated_at/deleted inside apply_block_patches); 22003 =
      // numeric_value_out_of_range. The payload is fixed, so retrying it can
      // only fail identically — drop it rather than jam the queue forever.
      // Classified permanent by code, independent of any threaded HTTP status.
      expect(classifyUploadError(postgrestError('22P02'))).toBe('permanent')
      expect(classifyUploadError(postgrestError('22003'))).toBe('permanent')
    })

    it('classifies 23xxx integrity-constraint violations as permanent', () => {
      // 23503 is the foreign-key violation that originally jammed the
      // upload queue when a child block referenced a parent the server
      // had never seen. Retrying the same op cannot succeed.
      expect(classifyUploadError(postgrestError('23503'))).toBe('permanent')
      expect(classifyUploadError(postgrestError('23505'))).toBe('permanent')
      expect(classifyUploadError(postgrestError('23514'))).toBe('permanent')
    })

    it('classifies 42xxx access/syntax errors as permanent', () => {
      // 42501 = insufficient_privilege — an RLS rejection, e.g. a workspace
      // un-shared out from under a pending write (revoked authorization);
      // this is the HTTP 403 case the upload path must QUARANTINE, not retry.
      // 42703 = undefined_column (client schema vs server schema drift).
      // Both indicate the request can never succeed unchanged.
      expect(classifyUploadError(postgrestError('42501'))).toBe('permanent')
      expect(classifyUploadError(postgrestError('42703'))).toBe('permanent')
    })

    it('classifies the JWT/auth codes (PGRST301/PGRST302) as transient — an expired token must not drop the write', () => {
      // PGRST301 = "JWT invalid or expired", PGRST302 = "anonymous access
      // disabled" — both HTTP 401 and RECOVERABLE: the token refreshes or the
      // user re-authenticates and the retry succeeds. Quarantining these would
      // silently drop a valid edit over a transient credentials problem. The
      // error CODE is what tells a recoverable expired-token (PGRST301) apart
      // from a permanent revoked-access RLS denial (42501) — not the 401/403,
      // which both can carry.
      expect(classifyUploadError(postgrestError('PGRST301'))).toBe('transient')
      expect(classifyUploadError(postgrestError('PGRST302'))).toBe('transient')
    })

    it('classifies the narrow PostgREST permanent codes (PGRST204, PGRST116) as permanent', () => {
      // PGRST204 = column not found in schema cache (client/server schema
      // drift); PGRST116 = result-cardinality mismatch. Both fail again
      // unchanged on retry, so they must be dropped, not re-queued.
      expect(classifyUploadError(postgrestError('PGRST204'))).toBe('permanent')
      expect(classifyUploadError(postgrestError('PGRST116'))).toBe('permanent')
    })

    it('keeps unknown PGRST codes transient (the list stays narrow)', () => {
      expect(classifyUploadError(postgrestError('PGRST500'))).toBe('transient')
    })

    it('classifies P0002 (no_data_found) as permanent', () => {
      // Raised by apply_block_patches when a patch's target row is
      // missing — the RPC rolls back via this exception, and the
      // missing row will not reappear on retry.
      expect(classifyUploadError(postgrestError('P0002'))).toBe('permanent')
    })
  })

  describe('HTTP status codes', () => {
    it('classifies payload-permanent 4xx client errors as permanent', () => {
      // The same payload can never satisfy these, so retrying forever would
      // jam the queue — drop them to the rejection table instead. 401/403 are
      // pointedly NOT here: those are recoverable (see the transient case).
      expect(classifyUploadError(httpError(400))).toBe('permanent')
      expect(classifyUploadError(httpError(404))).toBe('permanent')
      expect(classifyUploadError(httpError(409))).toBe('permanent')
      expect(classifyUploadError(httpError(413))).toBe('permanent')
      expect(classifyUploadError(httpError(422))).toBe('permanent')
    })

    it('classifies the retry-friendly 4xx subset (401/403/408/429) as transient', () => {
      // 408 = request timeout (often a network blip); 429 = rate limited —
      // both server-invited retries. 401/403 = an expired/not-yet-refreshed
      // session or a gateway-auth blip: recoverable once the token refreshes
      // or the user re-authenticates, so the queued write must be retried, not
      // dropped — dropping it would lose a valid edit over a credentials
      // problem. Genuine authorization failures (RLS denial) carry a code
      // (42501 / PGRST301) and are caught by the code branch, not by status.
      expect(classifyUploadError(httpError(401))).toBe('transient')
      expect(classifyUploadError(httpError(403))).toBe('transient')
      expect(classifyUploadError(httpError(408))).toBe('transient')
      expect(classifyUploadError(httpError(429))).toBe('transient')
    })

    it('classifies 5xx server errors as transient', () => {
      expect(classifyUploadError(httpError(500))).toBe('transient')
      expect(classifyUploadError(httpError(502))).toBe('transient')
      expect(classifyUploadError(httpError(503))).toBe('transient')
      expect(classifyUploadError(httpError(520))).toBe('transient')
    })
  })

  describe('code takes precedence over the threaded HTTP status', () => {
    it('keeps an unknown code-bearing error transient even with a permanent 4xx status', () => {
      // The status is now threaded onto every PostgREST error (#190), but a
      // structured code is the precise signal and must win. PGRST202
      // (stale/missing RPC signature after a migration) is surfaced by
      // PostgREST as HTTP 404 yet is recoverable once the schema cache
      // reloads — it is deliberately NOT in the permanent lists, so it must
      // stay transient. Were the 404 allowed to override the code, the queued
      // write would be dropped instead of retried.
      const staleRpc = Object.assign(new Error('Could not find the function'), {
        code: 'PGRST202',
        status: 404,
      })
      expect(classifyUploadError(staleRpc)).toBe('transient')
    })

    it('still classifies a known-permanent code as permanent even when the status alone would be transient', () => {
      // Inverse precedence check: a permanent code (FK violation) stays
      // permanent even if the threaded status (401) would, on its own,
      // classify transient. The code branch decides before status is consulted.
      const fk = Object.assign(new Error('fk'), {code: '23503', status: 401})
      expect(classifyUploadError(fk)).toBe('permanent')
    })
  })

  describe('network / unknown errors', () => {
    it('classifies plain Error (no code, no status) as transient', () => {
      // Default unknown → transient. The alternative — defaulting to
      // permanent — would silently drop user data when an error class
      // we haven't seen yet appears. Better to keep retrying loudly than
      // discard quietly; when a new permanent class shows up we add it
      // to the explicit list above.
      expect(classifyUploadError(new Error('fetch failed'))).toBe('transient')
    })

    it('classifies non-Error throws as transient', () => {
      // Defensive: code under `await` may throw strings or arbitrary
      // values. Treat as transient for the same safety reason as above.
      expect(classifyUploadError('some string')).toBe('transient')
      expect(classifyUploadError(null)).toBe('transient')
      expect(classifyUploadError(undefined)).toBe('transient')
      expect(classifyUploadError({foo: 'bar'})).toBe('transient')
    })

    it('falls back to transient when an unknown SQLSTATE class appears', () => {
      // A code we haven't categorised yet → don't drop the tx. The
      // loudly-logged retries will tell us to add a new case here.
      expect(classifyUploadError(postgrestError('99999'))).toBe('transient')
    })
  })
})
