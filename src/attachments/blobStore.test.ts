import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { BlobPutError, createSupabaseBlobStore } from './blobStore.js'

const makeStore = (fetchFn: typeof fetch, token: string | null = 'tok-123') =>
  createSupabaseBlobStore({
    client: {} as SupabaseClient, // put() never touches the client
    supabaseUrl: 'https://proj.supabase.co',
    anonKey: 'anon-key',
    getAccessToken: async () => token,
    fetchFn,
  })

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

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
  it('POSTs to the guard function with workspace_id + content_key params and bearer auth', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }))
    const bytes = new Uint8Array([1, 2, 3])
    await makeStore(fetchFn).put('ws-A', 'deadbeef', bytes)

    expect(fetchFn).toHaveBeenCalledOnce()
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(
      'https://proj.supabase.co/functions/v1/attachments-upload?workspace_id=ws-A&content_key=deadbeef',
    )
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok-123')
    expect(headers.apikey).toBe('anon-key')
    expect(headers['content-type']).toBe('application/octet-stream')
    expect(init?.body).toBe(bytes)
  })

  it('resolves on a 200 (including the idempotent-dedup response)', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true, deduped: true }))
    await expect(makeStore(fetchFn).put('ws', 'k', new Uint8Array())).resolves.toBeUndefined()
  })

  it('throws a PERMANENT BlobPutError on 422, carrying the body code', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(422, { code: 'not_ciphertext' }))
    const err = await putError(makeStore(fetchFn).put('ws', 'k', new Uint8Array()))
    expect(err.permanent).toBe(true)
    expect(err.status).toBe(422)
    expect(err.code).toBe('not_ciphertext')
  })

  it('treats 403 (not a writer) and 404 (no workspace) as permanent', async () => {
    for (const status of [403, 404]) {
      const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(status, { code: 'x' }))
      const err = await putError(makeStore(fetchFn).put('ws', 'k', new Uint8Array()))
      expect(err.permanent, `status ${status} should be permanent`).toBe(true)
    }
  })

  it('treats 5xx, 429, and network errors as TRANSIENT (retryable)', async () => {
    const transientResponders: Array<typeof fetch> = [
      vi.fn<typeof fetch>(async () => jsonResponse(500, {})),
      vi.fn<typeof fetch>(async () => jsonResponse(429, {})),
      vi.fn<typeof fetch>(async () => {
        throw new Error('offline')
      }),
    ]
    for (const fetchFn of transientResponders) {
      const err = await putError(makeStore(fetchFn).put('ws', 'k', new Uint8Array()))
      expect(err.permanent).toBe(false)
    }
  })

  it('treats a missing session token as transient and never attempts the upload', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(200, {}))
    const err = await putError(makeStore(fetchFn, null).put('ws', 'k', new Uint8Array()))
    expect(err.permanent).toBe(false)
    expect(err.code).toBe('no_session')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
