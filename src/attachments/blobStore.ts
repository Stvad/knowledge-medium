/**
 * The object-store seam (design docs/media-attachments/design.html §14).
 *
 * All object-store access goes behind this ~3-method interface so swapping
 * Supabase Storage for R2 / S3 / B2 later is a bytes-copy plus re-pointing one
 * module. The object is addressed by a per-workspace CONTENT KEY
 * (HMAC(K_id, sha256) for E2EE, sha256 for plaintext, §10) the caller computes;
 * BlobStore just routes bytes to `<workspaceId>/<contentKey>`.
 *
 * The mutation split (§10) — every call is a DIRECT, RLS-gated Storage request;
 * there is NO mediating upload service (the §10.1 reversal):
 *   - put    → a direct upload, RLS-gated to workspace writers. First-write-wins:
 *              `upsert: false` plus the bucket's *absent* UPDATE policy make a
 *              re-upload to an existing content path an idempotent no-op (Storage
 *              409 → resolve), never an overwrite (§10/§10.1).
 *   - get    → a direct RLS-gated Storage GET (member). The hot read path.
 *   - delete → a direct RLS-gated Storage delete (writer) — used by §16 GC and
 *              the §10.1 poison-correction, NOT by undo (§9).
 *
 * The E2EE `encb:v1:` byte shape is the CLIENT's invariant — it encodes before
 * upload (§9); the read side (the Phase-3 resolver, §7.3 — not yet built)
 * hash-verifies + AEAD-opens + fail-closes (§5.1), and an off-path audit
 * (scripts/attachments-ciphertext-audit.mjs) alerts on a stray plaintext object.
 * No server inspects the body on write (§10.1 reversal, §17): a storage.objects
 * policy can't see body bytes, and a malicious writer holds the key and forges
 * the magic anyway.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const ATTACHMENTS_BUCKET = 'attachments'

/**
 * A failed upload. `permanent` tells the §9 up-lane whether to quarantine the
 * record as `failed` (an auth/path/size rejection that won't clear on retry) or
 * keep it `pending` and retry with backoff (network / 5xx / a momentarily-absent
 * or expired session).
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
  /** Upload sealed bytes directly to `<workspaceId>/<contentKey>`, RLS-gated to
   *  workspace writers. Resolves on success or idempotent dedup (an existing
   *  path, §10.1); throws {@link BlobPutError}. The bytes come from `encodeBytes`
   *  (§5), which is ArrayBuffer-backed. */
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
  /** Probes for an active session. A momentarily-absent session is TRANSIENT
   *  (the §9 up-lane refreshes + retries rather than burning the record to
   *  `failed`); a present session that isn't a workspace writer is the permanent
   *  403 the upload itself returns. It is ONLY a presence-probe — the upload
   *  rides `client`'s own session, so this MUST read the same `SupabaseClient`'s
   *  auth store or it gives false confidence. (A present-but-expired token sails
   *  past the probe and is handled as a transient '400' by the classifier.) */
  getAccessToken: () => Promise<string | null>
}

/** Supabase Storage flattens every non-500 HTTP status to 400; the real
 *  semantic code is the STRING body `statusCode` (e.g. '403' RLS-denied,
 *  '413' over file_size_limit), which supabase-js surfaces as
 *  `StorageApiError.statusCode`. So classify on `statusCode`, NOT on the
 *  flattened numeric `.status`. These codes won't clear on retry → the §9
 *  record goes to `failed`: '403' not-a-writer / removed member, '404' bucket
 *  missing (misconfig), '413' over the bucket's file_size_limit. Everything
 *  else is transient — notably '400' (which also carries an *expired JWT*, which
 *  MUST retry after a refresh; a genuinely-malformed path can't occur with the
 *  machine-generated <ws>/<content-key>), '401', 5xx, and network. */
const PERMANENT_STATUS_CODES = new Set(['403', '404', '413'])

/** Storage "object already exists" → body `statusCode` '409'. The HTTP line is
 *  flattened to 400, so the numeric `.status` is NOT 409 — the string body code
 *  is the signal (the `.status === 409` arm is a defensive fallback, effectively
 *  dead against current Storage). A duplicate upload to a content-addressed path
 *  is first-write-wins SUCCESS, not an error (§10.1) — detect it so an unrelated
 *  error can't be mis-read as an idempotent success (which would clear the §9
 *  queue against an object that was never written). */
const isAlreadyExists = (err: { status?: number; statusCode?: string | number }): boolean =>
  String(err.statusCode) === '409' || err.status === 409

export const createSupabaseBlobStore = (deps: SupabaseBlobStoreDeps): BlobStore => {
  const { client, getAccessToken } = deps
  const objectPath = (workspaceId: string, contentKey: string) => `${workspaceId}/${contentKey}`

  return {
    async put(workspaceId, contentKey, bytes) {
      // No session → transient: the caller refreshes and retries (don't burn the
      // §9 record to `failed` over a momentarily-absent token). The upload rides
      // the client's own session, which the RLS insert policy authorizes.
      const token = await getAccessToken()
      if (!token) throw new BlobPutError('no active session', false, 401, 'no_session')

      let error: { status?: number; statusCode?: string; message?: string } | null
      try {
        ;({ error } = await client.storage
          .from(ATTACHMENTS_BUCKET)
          .upload(objectPath(workspaceId, contentKey), bytes, {
            contentType: 'application/octet-stream',
            upsert: false, // never overwrite — the path is content-addressed (§10); first-write-wins
          }))
      } catch (cause) {
        // supabase-js returns errors in the result, but classify an unexpected
        // throw as a transient network failure rather than crashing the drain.
        throw new BlobPutError(`upload network error: ${String(cause)}`, false, undefined, 'network')
      }

      if (!error) return // 200 — the object was written
      // Idempotent dedup: the path is already present (§10.1). The client
      // hash-verifies the stored object before clearing the §9 queue.
      if (isAlreadyExists(error)) return

      // Classify on the string body `statusCode` (the semantic code); the
      // numeric `.status` is flattened to 400 for every non-500 error, so it
      // can't distinguish a permanent 403/413 from a transient expired-JWT 400.
      const code = error.statusCode != null ? String(error.statusCode) : undefined
      const numeric = code != null && /^\d+$/.test(code) ? Number(code) : error.status
      throw new BlobPutError(
        `upload failed${code != null ? ` (${code})` : ''}: ${error.message ?? 'unknown error'}`,
        code != null && PERMANENT_STATUS_CODES.has(code),
        numeric,
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
