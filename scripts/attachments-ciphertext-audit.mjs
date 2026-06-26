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
// design). For each E2EE workspace prefix it lists objects and Range-GETs only
// the first 8 bytes, checking the `encb:v1:` magic — it never pulls a full body.
//
// Privilege: it uses a service-role key because it must read EVERY workspace's
// objects, bypassing RLS — a per-user member session would only cover the
// workspaces that user joined. The key only ever range-reads the 8-byte magic
// (no plaintext/ciphertext body), and the workflow has no `pull_request` trigger
// so the secret is not exposed to forks. (A lower-privilege scoped role would
// shrink blast radius if this posture is later judged too broad — a deliberate
// open question, not a silent default.) If the key is absent the audit is NOT
// ARMED: it emits a ::warning:: (visibly distinct from a green pass) and exits 0,
// so a never-configured tripwire can't masquerade as a healthy one.
//
// Public-repo hygiene: never logs raw workspace ids / object paths — only a
// short sha256 prefix, enough for an operator holding the mapping to locate the
// object without leaking identifiers into CI logs.

import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'

const ENCB_MAGIC = Buffer.from('encb:v1:') // must match src/sync/crypto/binaryEnvelope.ts
const PREFIX_BYTES = ENCB_MAGIC.length // we only need the first 8 bytes per object
const BUCKET = 'attachments'
const LIST_PAGE = 1000

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const redact = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12)
const note = (msg) => console.log(`::notice::${msg}`)
const warn = (msg) => console.log(`::warning::${msg}`)
const fail = (msg) => console.log(`::error::${msg}`)
const summary = (md) => {
  const f = process.env.GITHUB_STEP_SUMMARY
  if (!f) return
  // Best-effort: the step summary is cosmetic — never let a summary-write
  // failure (e.g. the runner's summary size cap) flip the audit's pass/fail.
  try {
    appendFileSync(f, `${md}\n`)
  } catch {
    /* ignore — the audit's signal comes from the ciphertext check, not the log */
  }
}

if (!url || !serviceKey) {
  // A green ::notice:: would make a never-configured (never-running) tripwire
  // indistinguishable from a healthy pass — so emit a ::warning:: (yellow run
  // annotation) and a step summary instead. Still exit 0: the secret is
  // legitimately unset until media capture (Phase 5) ships, so we don't want
  // daily red — just a visibly NOT-ARMED state.
  warn('attachments ciphertext audit NOT ARMED — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset; the tripwire did not run')
  summary('### ⚠️ Attachments ciphertext audit — NOT ARMED\nSecrets not configured; the audit did not run. Set `SUPABASE_SERVICE_ROLE_KEY` before media capture (Phase 5) ships.')
  process.exit(0)
}

const base = url.replace(/\/$/, '')
const authHeaders = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` }

/** E2EE workspace ids — the only prefixes that must be ciphertext. Paged: an
 *  unpaginated select is silently capped at PostgREST's db-max-rows, so past that
 *  many E2EE workspaces the audit would skip the rest and report clean while
 *  plaintext could exist there. Advance by the ACTUAL page length (the server may
 *  cap below the requested limit) and stop on an empty page. */
const e2eeWorkspaceIds = async () => {
  const ids = []
  for (let offset = 0; ; ) {
    const res = await fetch(
      `${base}/rest/v1/workspaces?select=id&encryption_mode=eq.e2ee&limit=${LIST_PAGE}&offset=${offset}`,
      { headers: authHeaders },
    )
    if (!res.ok) throw new Error(`workspaces query failed (${res.status}): ${await res.text()}`)
    const page = await res.json()
    if (page.length === 0) return ids
    for (const w of page) ids.push(w.id)
    offset += page.length
  }
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

  const tally = `${workspaces.length} E2EE workspace(s), ${scanned} object(s) scanned, ${violations.length} violation(s)`
  note(`attachments ciphertext audit: ${tally}`)
  if (violations.length > 0) {
    for (const v of violations) fail(`non-ciphertext object in an E2EE workspace: obj:${redact(v)}`)
    fail(`${violations.length} attachment object(s) under an E2EE prefix are NOT encb:v1: ciphertext — a client is uploading plaintext (§10.1/§17)`)
    summary(`### ❌ Attachments ciphertext audit — ${violations.length} violation(s)\n${tally}. A client is uploading plaintext into an E2EE workspace (§10.1/§17).`)
    process.exit(1)
  }
  summary(`### ✅ Attachments ciphertext audit — armed and clean\n${tally}.`)
}

main().catch((err) => {
  fail(`attachments ciphertext audit errored: ${err.message}`)
  process.exit(1)
})
