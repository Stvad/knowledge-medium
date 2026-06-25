/**
 * The object-store seam (design docs/media-attachments/design.html §14).
 *
 * All object-store access goes behind this ~3-method interface so swapping
 * Supabase Storage for R2 / S3 / B2 later is a bytes-copy plus re-pointing one
 * module. The object is addressed by a per-workspace CONTENT KEY
 * (HMAC(K_id, sha256) for E2EE, sha256 for plaintext, §10) the caller computes;
 * BlobStore just routes bytes to `<workspaceId>/<contentKey>`.
 *
 * The mutation split (§10):
 *   - put    → the §10.1 guard Edge Function (the SOLE writer; direct client
 *              insert/update is RLS-denied). First-write-wins idempotent.
 *   - get    → a direct RLS-gated Storage GET (member). The hot read path.
 *   - delete → a direct RLS-gated Storage delete (writer) — used by §16 GC and
 *              the §10.1 poison-correction, NOT by undo (§9).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const ATTACHMENTS_BUCKET = 'attachments'
const UPLOAD_FUNCTION = 'attachments-upload'

/**
 * A failed upload. `permanent` tells the §9 up-lane whether to quarantine the
 * record as `failed` (a shape/auth/path rejection that won't clear on retry) or
 * keep it `pending` and retry with backoff (network / 5xx / an expired token).
 */
export class BlobPutError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'BlobPutError'
  }
}

export interface BlobStore {
  /** Upload sealed bytes via the §10.1 guard function. Resolves on success or
   *  idempotent dedup (an existing path); throws {@link BlobPutError}. The bytes
   *  come from `encodeBytes` (§5), which is ArrayBuffer-backed. */
  put(workspaceId: string, contentKey: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>
  /** Direct RLS-gated GET of the stored object bytes. Throws if absent/denied. */
  get(workspaceId: string, contentKey: string): Promise<Uint8Array>
  /** Direct RLS-gated delete (writer). Idempotent: supabase-js `remove` returns
   *  200 with an EMPTY list (no error) when the object is absent or RLS-denied,
   *  so this resolves on a no-op. Fine for §16 GC; the §10.1 poison-correction
   *  must NOT infer "the path is now free" from this resolving — it GET-verifies
   *  the path is gone before re-uploading (the §9 re-attempt sweep does this). */
  delete(workspaceId: string, contentKey: string): Promise<void>
}

export interface SupabaseBlobStoreDeps {
  client: SupabaseClient
  /** Base Supabase URL — `${url}/functions/v1/attachments-upload` is derived. */
  supabaseUrl: string
  anonKey: string
  /** The current user's access token — the upload rides the user's session
   *  (which the function authorizes), not the anon key. */
  getAccessToken: () => Promise<string | null>
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch
}

/** Statuses that won't clear on retry → the §9 record goes to `failed`.
 *  422 = bad shape/path, 403 = not a writer, 404 = no such workspace. */
const PERMANENT_STATUSES = new Set([403, 404, 422])

export const createSupabaseBlobStore = (deps: SupabaseBlobStoreDeps): BlobStore => {
  const { client, anonKey, getAccessToken } = deps
  const fetchFn = deps.fetchFn ?? fetch
  const uploadUrl = `${deps.supabaseUrl.replace(/\/$/, '')}/functions/v1/${UPLOAD_FUNCTION}`
  const objectPath = (workspaceId: string, contentKey: string) => `${workspaceId}/${contentKey}`

  return {
    async put(workspaceId, contentKey, bytes) {
      const token = await getAccessToken()
      // No session → transient: the caller refreshes and retries (don't burn
      // the §9 record to `failed` over a momentarily-absent token).
      if (!token) throw new BlobPutError('no active session', false, 401, 'no_session')

      const url =
        `${uploadUrl}?workspace_id=${encodeURIComponent(workspaceId)}` +
        `&content_key=${encodeURIComponent(contentKey)}`

      let res: Response
      try {
        res = await fetchFn(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            apikey: anonKey,
            'content-type': 'application/octet-stream',
          },
          body: bytes,
        })
      } catch (cause) {
        throw new BlobPutError(`upload network error: ${String(cause)}`, false, undefined, 'network')
      }

      if (res.ok) return // 200, including the idempotent-dedup case
      const code = await res
        .json()
        .then((b: { code?: string }) => b?.code)
        .catch(() => undefined)
      throw new BlobPutError(
        `upload failed (${res.status})`,
        PERMANENT_STATUSES.has(res.status),
        res.status,
        code,
      )
    },

    async get(workspaceId, contentKey) {
      const { data, error } = await client.storage
        .from(ATTACHMENTS_BUCKET)
        .download(objectPath(workspaceId, contentKey))
      if (error) throw error
      if (!data) throw new Error(`blob get: empty body for ${objectPath(workspaceId, contentKey)}`)
      return new Uint8Array(await data.arrayBuffer())
    },

    async delete(workspaceId, contentKey) {
      const { error } = await client.storage
        .from(ATTACHMENTS_BUCKET)
        .remove([objectPath(workspaceId, contentKey)])
      if (error) throw error
    },
  }
}
