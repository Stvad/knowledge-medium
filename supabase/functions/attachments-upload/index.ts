// The SOLE writer of the `attachments` Storage bucket.
// Design: docs/media-attachments/design.html §10.1 ("Server-side ciphertext
// enforcement for E2EE bytes").
//
// Direct client insert/update to the bucket is denied by RLS (§10), so every
// upload flows THROUGH this function, which per request:
//   1. authenticates the caller's JWT;
//   2. authorizes the write — writer membership for the path's workspace —
//      BEFORE using the service-role (bypass-RLS) credential. The service-role
//      write must re-impose the authorization that direct RLS would have, or a
//      read-only / removed member who can invoke the function could write bytes
//      the storage policies deny;
//   3. for an object under an E2EE-workspace prefix, rejects a body that is not
//      a well-formed `encb:v1:` envelope (the binary analog of the text path's
//      is_enc_v1_envelope) with a PERMANENT failure (HTTP 422), which the
//      client maps to the §9 `failed` state (quarantine, not a hot retry loop);
//   4. writes the body to `<workspace_id>/<content-key>` with the service role,
//      FIRST-WRITE-WINS — a PUT to a new path writes; a PUT to an existing path
//      is an idempotent 200, never an overwrite (the content-addressed path IS
//      the idempotency key, §10). The uploading client must still hash-verify an
//      existing object before clearing its queue (§10.1) — that check lives in
//      the client, not here.
//
// The guard is SHAPE-ONLY (the server has no key); a body that passes the magic
// check but isn't real ciphertext is caught fail-closed by the read-side hash
// check (§5.1). The body is buffered then PUT, so a truncated request can't win
// the path with a partial object (§10.1 atomicity).
//
// Reads + deletes do NOT go through here — they're direct, RLS-gated (§10).
// Only writes (insert/update), which the bucket denies to clients.

import { createClient } from 'jsr:@supabase/supabase-js@2'

// Binary envelope magic + minimum length — must match src/sync/crypto/
// binaryEnvelope.ts (encb:v1: ‖ nonce(12) ‖ ciphertext‖tag(16)).
const ENCB_MAGIC = new TextEncoder().encode('encb:v1:')
const NONCE_BYTES = 12
const GCM_TAG_BYTES = 16
const ENCB_MIN_LEN = ENCB_MAGIC.length + NONCE_BYTES + GCM_TAG_BYTES

const BUCKET = 'attachments'
const WRITER_ROLES = ['owner', 'editor']
// Server-side DoS backstop on body size — stops an abusive caller forcing a
// huge in-memory buffer in the isolate. The user-facing inline cap is the
// client capture guard (§11 / §16, "a v1 cap e.g. 10 MB"); this is just a
// ceiling well above any legitimate attachment.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-client-info, apikey',
  'access-control-allow-methods': 'POST, OPTIONS',
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  })

/** The binary analog of public.is_enc_v1_envelope: encb:v1: magic + at least a
 *  nonce and a GCM tag. Shape-only (no key). */
const hasEncbEnvelope = (bytes: Uint8Array): boolean => {
  if (bytes.length < ENCB_MIN_LEN) return false
  for (let i = 0; i < ENCB_MAGIC.length; i++) {
    if (bytes[i] !== ENCB_MAGIC[i]) return false
  }
  return true
}

/** Storage "object already exists" — Supabase returns HTTP 409. supabase-js
 *  surfaces it as a StorageApiError carrying `.status` (numeric) and
 *  `.statusCode` ("409"). Key on the STATUS, not the message text, so an
 *  unrelated error whose message happens to contain "exists" can't be mis-read
 *  as an idempotent success (which would clear the client's §9 queue against an
 *  object that was never written). */
const isAlreadyExists = (err: { status?: number; statusCode?: string | number }): boolean =>
  err.status === 409 || String(err.statusCode) === '409'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(500, { error: 'function misconfigured' })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json(401, { error: 'missing Authorization' })

  // ── 1. Authenticate the caller's JWT ──────────────────────────────────
  const authed = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: userData, error: userErr } = await authed.auth.getUser()
  if (userErr || !userData?.user) return json(401, { error: 'invalid token' })
  const userId = userData.user.id

  // Object identity: <workspace_id>/<content-key>. Passed as separate query
  // params (each a single path segment) so the client never URL-encodes an
  // embedded slash, and a malicious content_key can't smuggle a different
  // workspace into the path (validated below: non-empty, no '/', no traversal).
  const params = new URL(req.url).searchParams
  const workspaceId = params.get('workspace_id') ?? ''
  const contentKey = params.get('content_key') ?? ''
  const badSegment = (v: string) => v.length === 0 || v.includes('/') || v === '.' || v === '..'
  if (badSegment(workspaceId) || badSegment(contentKey)) {
    return json(422, { error: 'workspace_id and content_key must be non-empty path segments', code: 'bad_path' })
  }

  // Service-role client — bypasses RLS, so it can read membership/mode and
  // write the object. private.is_workspace_writer is not PostgREST-exposed, so
  // we authorize by querying workspace_members directly, mirroring it exactly
  // (role in owner/editor).
  const admin = createClient(supabaseUrl, serviceKey)

  // ── 2. Authorize: writer membership for THIS path's workspace ──────────
  const { data: member, error: memberErr } = await admin
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .in('role', WRITER_ROLES)
    .maybeSingle()
  if (memberErr) return json(500, { error: 'authorization check failed' })
  if (!member) return json(403, { error: 'not a workspace writer', code: 'forbidden' })

  // ── 3. Inspect the body (shape-only ciphertext guard for E2EE) ─────────
  const { data: ws, error: wsErr } = await admin
    .from('workspaces')
    .select('encryption_mode')
    .eq('id', workspaceId)
    .maybeSingle()
  if (wsErr) return json(500, { error: 'workspace lookup failed' })
  if (!ws) return json(404, { error: 'workspace not found', code: 'no_workspace' })

  // Reject an obviously-oversize upload before buffering it; the authoritative
  // check is on the buffered length (a lying / absent content-length).
  const declaredLength = Number(req.headers.get('content-length') ?? 'NaN')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    return json(422, { error: 'attachment exceeds the maximum size', code: 'too_large' })
  }
  let body: Uint8Array
  try {
    body = new Uint8Array(await req.arrayBuffer())
  } catch {
    // Aborted / truncated request — transient; the client retries (§9). The
    // buffer-then-PUT below means a partial body never reaches Storage.
    return json(500, { error: 'failed to read request body' })
  }
  if (body.length === 0) return json(422, { error: 'empty body', code: 'empty_body' })
  if (body.length > MAX_UPLOAD_BYTES) {
    return json(422, { error: 'attachment exceeds the maximum size', code: 'too_large' })
  }

  if (ws.encryption_mode === 'e2ee' && !hasEncbEnvelope(body)) {
    // PERMANENT failure — a shape rejection only clears when the client is
    // fixed; the client maps this to the §9 `failed` state, not a retry.
    return json(422, {
      error: 'e2ee workspace requires an encb:v1: ciphertext body',
      code: 'not_ciphertext',
    })
  }

  // ── 4. First-write-wins write with the service role ────────────────────
  const objectPath = `${workspaceId}/${contentKey}`
  const { error: upErr } = await admin.storage.from(BUCKET).upload(objectPath, body, {
    contentType: 'application/octet-stream',
    upsert: false, // never overwrite — the path is content-addressed (§10)
  })
  if (upErr) {
    if (isAlreadyExists(upErr)) {
      // Idempotent dedup: the object is already present. The client verifies it
      // against its own hash before clearing the §9 queue (§10.1).
      return json(200, { ok: true, path: objectPath, deduped: true })
    }
    // Transient (network / storage) — the client retries with backoff (§9).
    return json(500, { error: 'storage write failed', detail: upErr.message })
  }
  return json(200, { ok: true, path: objectPath })
})
