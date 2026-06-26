import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { ATTACHMENTS_BUCKET, BlobPutError, createSupabaseBlobStore } from './blobStore.js'

/** A StorageApiError-shaped result error, as supabase-js surfaces it. */
type UploadResult = { error: { status?: number; statusCode?: string; message?: string } | null }
type UploadFn = (path: string, body: unknown, opts: unknown) => Promise<UploadResult>

/** Minimal client exposing just `storage.from(bucket).upload(...)` — put() never
 *  touches anything else. Returns the captured upload spy for assertions. */
const makeStore = (upload: UploadFn, token: string | null = 'tok-123') => {
  const from = vi.fn(() => ({ upload }))
  const client = { storage: { from } } as unknown as SupabaseClient
  const store = createSupabaseBlobStore({ client, getAccessToken: async () => token })
  return { store, from }
}

const ok = async (): Promise<UploadResult> => ({ error: null })
// Mirror the REAL supabase-js shape: Storage flattens every non-500 HTTP status
// to 400, and the semantic code lives in the STRING body `statusCode` (500 stays
// 500). A statusless error models an offline StorageUnknownError.
const fail = (statusCode?: string): UploadFn => async () => ({
  error: {
    status: statusCode == null ? undefined : statusCode === '500' ? 500 : 400,
    statusCode,
    message: `code ${statusCode ?? 'network'}`,
  },
})

/** Await a put expected to reject, returning the typed BlobPutError. */
const putError = async (p: Promise<void>): Promise<BlobPutError> => {
  try {
    await p
  } catch (e) {
    if (e instanceof BlobPutError) return e
    throw e
  }
  throw new Error('expected put to reject with a BlobPutError, but it resolved')
}

describe('SupabaseBlobStore.put', () => {
  it('uploads directly to <ws>/<contentKey> in the attachments bucket, first-write-wins', async () => {
    const upload = vi.fn<UploadFn>(ok)
    const bytes = new Uint8Array([1, 2, 3])
    const { store, from } = makeStore(upload)
    await store.put('ws-A', 'deadbeef', bytes)

    expect(from).toHaveBeenCalledWith(ATTACHMENTS_BUCKET)
    expect(upload).toHaveBeenCalledOnce()
    const [path, body, opts] = upload.mock.calls[0]
    expect(path).toBe('ws-A/deadbeef')
    expect(body).toBe(bytes)
    expect(opts).toMatchObject({ upsert: false, contentType: 'application/octet-stream' })
  })

  it('resolves on success', async () => {
    await expect(makeStore(ok).store.put('ws', 'k', new Uint8Array())).resolves.toBeUndefined()
  })

  it('resolves on a 409 (existing path) as idempotent first-write-wins dedup', async () => {
    // The duplicate's HTTP line is the flattened 400; the '409' is in the body
    // statusCode — so detection must key on statusCode, not the numeric status.
    await expect(makeStore(fail('409')).store.put('ws', 'k', new Uint8Array())).resolves.toBeUndefined()
  })

  it('treats 403 (not a writer), 404 (no bucket), 413 (too large) as PERMANENT', async () => {
    for (const code of ['403', '404', '413']) {
      const err = await putError(makeStore(fail(code)).store.put('ws', 'k', new Uint8Array()))
      expect(err.permanent, `code ${code} should be permanent`).toBe(true)
      expect(err.status).toBe(Number(code)) // the semantic code, not the flattened 400
    }
  })

  it('treats an expired/invalid JWT (body code 400) as TRANSIENT, not quarantined', async () => {
    // Storage surfaces an expired token as statusCode '400'; it must retry after
    // a session refresh, NOT burn the §9 record to `failed`.
    const err = await putError(makeStore(fail('400')).store.put('ws', 'k', new Uint8Array()))
    expect(err.permanent).toBe(false)
  })

  it('treats 401, 5xx, and an unknown/network error as TRANSIENT (retryable)', async () => {
    for (const code of ['401', '500', '503']) {
      const err = await putError(makeStore(fail(code)).store.put('ws', 'k', new Uint8Array()))
      expect(err.permanent, `code ${code} should be transient`).toBe(false)
    }
    // A statusless error (e.g. an offline StorageUnknownError) is transient.
    const networkErr = await putError(makeStore(fail()).store.put('ws', 'k', new Uint8Array()))
    expect(networkErr.permanent).toBe(false)
    expect(networkErr.status).toBeUndefined()
  })

  it('treats an unexpected throw from upload as a transient network error', async () => {
    const upload = vi.fn<UploadFn>(async () => {
      throw new Error('offline')
    })
    const err = await putError(makeStore(upload).store.put('ws', 'k', new Uint8Array()))
    expect(err.permanent).toBe(false)
    expect(err.code).toBe('network')
  })

  it('treats a missing session as transient and never attempts the upload', async () => {
    const upload = vi.fn<UploadFn>(ok)
    const err = await putError(makeStore(upload, null).store.put('ws', 'k', new Uint8Array()))
    expect(err.permanent).toBe(false)
    expect(err.code).toBe('no_session')
    expect(upload).not.toHaveBeenCalled()
  })
})
