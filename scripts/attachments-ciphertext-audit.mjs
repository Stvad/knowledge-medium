// Off-path ciphertext audit for the `attachments` bucket (design §10.1 / §17).
//
// Direct client uploads (no body-inspecting upload service) mean the "E2EE
// objects are encb:v1: ciphertext" invariant rests on the client encoding
// correctly before upload (§9) plus the read-side hash/AEAD fail-close
// (§5.1/§7.3). This audit is the TRIPWIRE that turns an HONEST-client
// regression (accidentally uploading bare plaintext into an E2EE workspace)
// from silent into loud — it runs OFF the write path (scheduled), never gating
// uploads. It is NOT a confidentiality control: a malicious writer forges the
// 8-byte magic, and by the time anything lands the untrusted server already
// holds it. It catches our own bugs, and it ALERTS — it does not delete.
//
// Scope: only E2EE workspaces (a plaintext workspace's objects are raw bytes by
// design). For each E2EE workspace prefix it lists objects and Range-GETs the
// first bytes, checking the `encb:v1:` magic. Needs a service-role key (to read
// every workspace's objects, bypassing RLS); if absent it SKIPS cleanly (exit 0)
// so the scheduled job is green-but-noop until the secret is configured.
//
// Public-repo hygiene: never logs raw workspace ids / object paths — only a
// short salted-free sha256 prefix, enough for an operator holding the mapping to
// locate the object without leaking identifiers into CI logs.

import { createHash } from 'node:crypto'

const ENCB_MAGIC = Buffer.from('encb:v1:') // must match src/sync/crypto/binaryEnvelope.ts
const PREFIX_BYTES = ENCB_MAGIC.length // we only need the first 8 bytes per object
const BUCKET = 'attachments'
const LIST_PAGE = 1000

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const redact = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12)
const note = (msg) => console.log(`::notice::${msg}`)
const fail = (msg) => console.log(`::error::${msg}`)

if (!url || !serviceKey) {
  note('attachments ciphertext audit skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
  process.exit(0)
}

const base = url.replace(/\/$/, '')
const authHeaders = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` }

/** E2EE workspace ids — the only prefixes that must be ciphertext. */
const e2eeWorkspaceIds = async () => {
  const res = await fetch(`${base}/rest/v1/workspaces?select=id&encryption_mode=eq.e2ee`, {
    headers: authHeaders,
  })
  if (!res.ok) throw new Error(`workspaces query failed (${res.status}): ${await res.text()}`)
  return (await res.json()).map((w) => w.id)
}

/** All object names under a workspace prefix (flat <ws>/<key> layout), paginated. */
const listObjects = async (workspaceId) => {
  const names = []
  for (let offset = 0; ; offset += LIST_PAGE) {
    const res = await fetch(`${base}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ prefix: `${workspaceId}/`, limit: LIST_PAGE, offset }),
    })
    if (!res.ok) throw new Error(`list failed (${res.status}): ${await res.text()}`)
    const page = await res.json()
    // Folder entries (nested) have a null id; our layout is flat, so keep files.
    for (const item of page) if (item.id) names.push(`${workspaceId}/${item.name}`)
    if (page.length < LIST_PAGE) return names
  }
}

/** True iff the object's first bytes are the encb:v1: magic. */
const isCiphertext = async (objectPath) => {
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/')
  const res = await fetch(`${base}/storage/v1/object/authenticated/${BUCKET}/${encoded}`, {
    headers: { ...authHeaders, range: `bytes=0-${PREFIX_BYTES - 1}` },
  })
  if (!res.ok) throw new Error(`object read failed (${res.status})`)
  const head = Buffer.from(await res.arrayBuffer()).subarray(0, PREFIX_BYTES)
  return head.equals(ENCB_MAGIC)
}

const main = async () => {
  const workspaces = await e2eeWorkspaceIds()
  let scanned = 0
  const violations = []
  for (const ws of workspaces) {
    for (const objectPath of await listObjects(ws)) {
      scanned += 1
      if (!(await isCiphertext(objectPath))) violations.push(objectPath)
    }
  }

  note(`attachments ciphertext audit: ${workspaces.length} E2EE workspace(s), ${scanned} object(s) scanned, ${violations.length} violation(s)`)
  if (violations.length > 0) {
    for (const v of violations) fail(`non-ciphertext object in an E2EE workspace: obj:${redact(v)}`)
    fail(`${violations.length} attachment object(s) under an E2EE prefix are NOT encb:v1: ciphertext — a client is uploading plaintext (§10.1/§17)`)
    process.exit(1)
  }
}

main().catch((err) => {
  fail(`attachments ciphertext audit errored: ${err.message}`)
  process.exit(1)
})
