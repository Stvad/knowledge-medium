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

    it('classifies the malformed-request and schema PostgREST codes (PGRST10x / 204 / 116) as permanent', () => {
      // PGRST100-103 = malformed request (query-string parse / wrong method /
      // invalid body / invalid range) — for our fixed-shape rpc/upsert/delete
      // these are client bugs that retrying can't fix. PGRST204 = column not
      // found in the schema cache (drift); PGRST116 = result-cardinality
      // mismatch. All fail identically on retry → quarantine, don't re-queue.
      expect(classifyUploadError(postgrestError('PGRST100'))).toBe('permanent')
      expect(classifyUploadError(postgrestError('PGRST102'))).toBe('permanent')
      expect(classifyUploadError(postgrestError('PGRST204'))).toBe('permanent')
      expect(classifyUploadError(postgrestError('PGRST116'))).toBe('permanent')
    })

    it('keeps an unknown code with no status transient (no confirmed client-error signal)', () => {
      // An unrecognised code with no HTTP status to disambiguate stays
      // transient — we don't quarantine a write on a code we can't classify and
      // have no 4xx signal for. (An unknown code WITH a 4xx status is
      // `ambiguous`; see the precedence block below.)
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
    it('classifies a codeless non-retryable 4xx as ambiguous (retry-budget, then quarantine)', () => {
      // A 4xx with no structured code is a SUSPECTED client error we can't
      // confirm is permanent — so it's `ambiguous`: the orchestrator retries it
      // a few times (absorbing a transient blip) and quarantines it only if it
      // won't clear, rather than dropping it immediately or jamming forever.
      // 401/403 are pointedly NOT here — those are recoverable (transient).
      expect(classifyUploadError(httpError(400))).toBe('ambiguous')
      expect(classifyUploadError(httpError(404))).toBe('ambiguous')
      expect(classifyUploadError(httpError(409))).toBe('ambiguous')
      expect(classifyUploadError(httpError(413))).toBe('ambiguous')
      expect(classifyUploadError(httpError(422))).toBe('ambiguous')
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

  describe('a recognised code wins over the threaded status; an unknown 4xx is ambiguous', () => {
    it('classifies a known-recoverable code (PGRST202) transient even with a permanent-looking 404', () => {
      // PGRST202 (stale/missing RPC signature after a migration) is surfaced by
      // PostgREST as HTTP 404 yet self-heals once the schema cache reloads — it
      // is in the RECOVERABLE set, so it stays transient. Were the 404 allowed
      // to override the code, the queued write would be quarantined, not retried.
      const staleRpc = Object.assign(new Error('Could not find the function'), {
        code: 'PGRST202',
        status: 404,
      })
      expect(classifyUploadError(staleRpc)).toBe('transient')
    })

    it('classifies a known-permanent code permanent even when the status alone would be transient', () => {
      // Inverse precedence check: a permanent code (FK violation) wins even if
      // the threaded status (401) would, on its own, classify transient. The
      // code branch decides before the status is consulted.
      const fk = Object.assign(new Error('fk'), {code: '23503', status: 401})
      expect(classifyUploadError(fk)).toBe('permanent')
    })

    it('classifies an UNKNOWN code with a non-retryable 4xx as ambiguous', () => {
      // An unrecognised code (in no list) falls through to the status: a
      // non-retryable 4xx makes it `ambiguous` (retry-budget then quarantine) —
      // neither an immediate drop (it could be a recoverable code we haven't
      // catalogued) nor the old infinite jam.
      const unknown = Object.assign(new Error('weird'), {code: 'PGRST999', status: 400})
      expect(classifyUploadError(unknown)).toBe('ambiguous')
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
