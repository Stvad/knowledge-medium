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
    it('classifies 23xxx integrity-constraint violations as permanent', () => {
      // 23503 is the foreign-key violation that originally jammed the
      // upload queue when a child block referenced a parent the server
      // had never seen. Retrying the same op cannot succeed.
      expect(classifyUploadError(postgrestError('23503'))).toBe('permanent')
      expect(classifyUploadError(postgrestError('23505'))).toBe('permanent')
      expect(classifyUploadError(postgrestError('23514'))).toBe('permanent')
    })

    it('classifies 42xxx access/syntax errors as permanent', () => {
      // 42501 = insufficient_privilege (RLS rejection at the GRANT level).
      // 42703 = undefined_column (client schema vs server schema drift).
      // Both indicate the request can never succeed unchanged.
      expect(classifyUploadError(postgrestError('42501'))).toBe('permanent')
      expect(classifyUploadError(postgrestError('42703'))).toBe('permanent')
    })

    it('classifies PostgREST RLS denials (PGRST301) as permanent', () => {
      expect(classifyUploadError(postgrestError('PGRST301'))).toBe('permanent')
    })

    it('classifies P0002 (no_data_found) as permanent', () => {
      // Raised by apply_block_patches when a patch's target row is
      // missing — the RPC rolls back via this exception, and the
      // missing row will not reappear on retry.
      expect(classifyUploadError(postgrestError('P0002'))).toBe('permanent')
    })
  })

  describe('HTTP status codes', () => {
    it('classifies 4xx client errors as permanent', () => {
      expect(classifyUploadError(httpError(400))).toBe('permanent')
      expect(classifyUploadError(httpError(401))).toBe('permanent')
      expect(classifyUploadError(httpError(403))).toBe('permanent')
      expect(classifyUploadError(httpError(404))).toBe('permanent')
      expect(classifyUploadError(httpError(409))).toBe('permanent')
    })

    it('classifies 408/429 as transient (the retry-friendly 4xx subset)', () => {
      // 408 = request timeout (client side, often network blip).
      // 429 = rate limited; server explicitly invites a retry.
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
