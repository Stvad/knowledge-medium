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
 *  plaintext could exist there. `order=id.asc` is REQUIRED — offset pagination
 *  over an unordered result is planner-dependent and can skip/duplicate rows
 *  across pages (a skipped workspace = unchecked prefix = false-clean). Advance by
 *  the ACTUAL page length (the server may cap below the requested limit) and stop
 *  on an empty page. */
const e2eeWorkspaceIds = async () => {
  const ids = []
  for (let offset = 0; ; ) {
    const res = await fetch(
      `${base}/rest/v1/workspaces?select=id&encryption_mode=eq.e2ee&order=id.asc&limit=${LIST_PAGE}&offset=${offset}`,
      { headers: authHeaders },
    )
    // Status only — never interpolate the response body: this runs in public CI
    // and a body could echo the request prefix (a workspace id).
    if (!res.ok) throw new Error(`workspaces query failed (${res.status})`)
    const page = await res.json()
    if (page.length === 0) return ids
    for (const w of page) ids.push(w.id)
    offset += page.length
  }
}

/** Top-level entries under a workspace prefix, paginated. The layout is flat
 *  (<ws>/<key>): a file has an id, a nested SUBFOLDER comes back with a null id.
 *  Nesting is supposed to be impossible (RLS enforces array_length(foldername)=1),
 *  so we surface any folder entry as a finding rather than silently skipping it —
 *  a nested object could otherwise hide plaintext from this top-level scan. */
const listObjects = async (workspaceId) => {
  const files = []
  const nested = []
  for (let offset = 0; ; offset += LIST_PAGE) {
    const res = await fetch(`${base}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      // Explicit stable sort — same reason as the workspace query: offset
      // pagination needs a deterministic order or it can skip/duplicate entries.
      body: JSON.stringify({
        prefix: `${workspaceId}/`,
        limit: LIST_PAGE,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      }),
    })
    if (!res.ok) throw new Error(`list failed (${res.status})`) // status only — no body (public CI)
    const page = await res.json()
    for (const item of page) {
      if (item.id) files.push(`${workspaceId}/${item.name}`)
      else nested.push(`${workspaceId}/${item.name}/`)
    }
    if (page.length < LIST_PAGE) return { files, nested }
  }
}

/** Classify an object by its first bytes: 'ok' (encb:v1: magic), 'plaintext'
 *  (readable but wrong magic), 'unreadable' (a per-object read failure — a 416 on
 *  a 0-byte/truncated object, the exact buggy-client case this tripwire targets;
 *  or a 5xx/network), or 'gone' (404 — deleted between list and read; benign).
 *  A per-object failure is a per-object verdict, NEVER a fatal throw: one odd
 *  object must not red/abort the whole audit, and the operator still gets a
 *  redacted path to locate it. */
const classifyObject = async (objectPath) => {
  // The WHOLE per-object op is under one catch (incl. the path encode): the fetch
  // promise resolves on headers, so the body (await arrayBuffer) streams lazily
  // and can drop mid-stream AFTER a 200/206 — that, and any other per-object
  // throw, must degrade to 'unreadable', never propagate and abort the audit.
  try {
    const encoded = objectPath.split('/').map(encodeURIComponent).join('/')
    const res = await fetch(`${base}/storage/v1/object/authenticated/${BUCKET}/${encoded}`, {
      headers: { ...authHeaders, range: `bytes=0-${PREFIX_BYTES - 1}` },
    })
    if (res.status === 404) return 'gone' // vanished mid-scan — nothing to verify
    if (!res.ok) return 'unreadable' // 416 empty / 5xx — flag, don't abort
    const head = Buffer.from(await res.arrayBuffer()).subarray(0, PREFIX_BYTES)
    return head.equals(ENCB_MAGIC) ? 'ok' : 'plaintext'
  } catch {
    return 'unreadable'
  }
}

const main = async () => {
  const workspaces = await e2eeWorkspaceIds()
  let scanned = 0
  const violations = [] // { kind: 'plaintext' | 'nested' | 'unreadable', path }
  for (const ws of workspaces) {
    const { files, nested } = await listObjects(ws)
    for (const path of nested) violations.push({ kind: 'nested', path })
    for (const path of files) {
      const verdict = await classifyObject(path)
      if (verdict === 'gone') continue // vanished mid-scan; nothing to verify
      scanned += 1
      if (verdict === 'plaintext') violations.push({ kind: 'plaintext', path })
      else if (verdict === 'unreadable') violations.push({ kind: 'unreadable', path })
    }
  }

  const tally = `${workspaces.length} E2EE workspace(s), ${scanned} object(s) scanned, ${violations.length} finding(s)`
  note(`attachments ciphertext audit: ${tally}`)
  if (violations.length > 0) {
    const reasons = {
      nested: 'unexpected NESTED entry under an E2EE prefix (layout must be flat — could hide plaintext)',
      unreadable: 'UNREADABLE object under an E2EE prefix (empty/truncated/errored — not verifiable as ciphertext)',
      plaintext: 'non-ciphertext object in an E2EE workspace',
    }
    for (const v of violations) fail(`${reasons[v.kind]}: obj:${redact(v.path)}`)
    fail(`${violations.length} finding(s) under an E2EE prefix — a client is uploading plaintext, nesting, or writing unverifiable objects (§10.1/§17)`)
    summary(`### ❌ Attachments ciphertext audit — ${violations.length} finding(s)\n${tally}. Plaintext, non-flat, or unreadable object under an E2EE workspace (§10.1/§17).`)
    process.exit(1)
  }
  summary(`### ✅ Attachments ciphertext audit — armed and clean\n${tally}.`)
}

main().catch((err) => {
  fail(`attachments ciphertext audit errored: ${err.message}`)
  process.exit(1)
})
