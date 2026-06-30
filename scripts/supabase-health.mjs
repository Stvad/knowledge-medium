#!/usr/bin/env node
// Hourly health probe for the Supabase project. Designed to be run from GitHub
// Actions cron; emits a JSON snapshot on stdout and exits non-zero on any fail
// threshold. Workflow failure is the alert channel.
//
// Required env: SUPABASE_POOLER_URI (IPv4 pooler — GH runners are IPv4-only).
// Optional env: SUPABASE_URL + SUPABASE_ANON_KEY (enables external HTTP
// probes of the project's PostgREST and Auth endpoints — measures the
// outside-world view alongside the inside DB view).
//
// Thresholds — keep in sync with comments in the monitoring memory note.

import pg from 'pg'
import { createHash } from 'node:crypto'

// The probe's JSON snapshot is printed to stdout, which lands in a PUBLIC GitHub
// Actions log (and the FAIL email body). `actor` (a user UUID) and `workspace_id`
// are PII — never emit them raw. A truncated salt-free hash of a random UUID is
// non-reversible (huge keyspace) yet stable, so the operator can still tell
// "one actor did all of this" by hashing a known id, without leaking it.
const redactId = (v) => (v == null ? null : createHash('sha256').update(String(v)).digest('hex').slice(0, 12))

const SNAPSHOT_WARN_MB = 50
const SNAPSHOT_FAIL_MB = 200
const MAPPING_WARN_MB = 20
const MAPPING_FAIL_MB = 100
const TMPDIR_FAIL_MB = 100
// PowerSync's initial-sync chatter can push WAL to ~500 MB transiently;
// pg keeps preallocated segments. Thresholds set to catch unbounded growth
// (multi-GB), not normal operation.
const WAL_WARN_MB = 2000
const WAL_FAIL_MB = 5000
// DB size — Pro plan starts on an 8 GB disk that autoscales, so there is no
// fixed plan cap (unlike Free's 500 MB). These are growth/cost backstops sized
// to go red BEFORE the included disk fills, not a hard cap. The writable check
// below is the true disk-full detector; bump these if you provision a larger disk.
const DB_SIZE_WARN_MB = 5000
const DB_SIZE_FAIL_MB = 7000
const IDLE_IN_TX_FAIL_SECONDS = 60 * 60
const CONNECTIONS_WARN_PCT = 0.83
const CONNECTIONS_FAIL_PCT = 0.97
const VACUUM_WARN_HOURS = 48
const EXPECTED_RLS_TABLES = ['workspaces', 'workspace_members', 'workspace_invitations', 'blocks']
const EXPECTED_PUB_TABLES = ['blocks', 'workspace_members', 'workspaces']
const EXPECTED_LOGICAL_SLOTS_MIN = 1
const EXPECTED_LOGICAL_SLOTS_MAX = 1

// --- Data-integrity (L5) detectors over blocks_history ---------------------
// Read-only anomaly detection on the server-side change log. See
// docs/data-integrity-defense.html §3 L5 for the design and §4 for blind
// spots. Posture is WARN-by-default: every detector surfaces in the JSON
// snapshot and, via the tail block, as a GitHub `::warning::` annotation; only
// the catastrophe tiers (≥ FAIL) push to result.failures and exit(1) — which
// reds the job and is the page. DATA_INTEGRITY_STRICT=1 promotes every WARN to
// a FAIL (a migration-window toggle; leave off in steady state — `deletions`
// reaches ~130/window in normal editing and STRICT would page on it).
//
// These detectors read the *server*, so they are plaintext-only: in an e2ee
// workspace `references_json`/`properties_json` are ciphertext (never `[]` /
// never `{...}`) and in a history-trigger-off window there are no rows — both
// are documented blind spots, not bugs.
//
// Thresholds (per actor+workspace over the window, except at_rest = fleet
// total) baselined 2026-06-23 against 48h/30 cron runs on the live fleet
// (observed per-window maxima: refs_emptied durable 0, prop_key_removal 3,
// deletions 131, bulk_bump 12, at_rest constant 1). Calibrated so a
// few-hundred-row mistake pages while observed-normal activity never does.
// Keep in sync with the §3 L5 table.
const INTEGRITY_WINDOW_MIN = 90
const CURATED_REF_PROPS = ['next-review-date']
const REFS_EMPTIED_WARN = 25
const REFS_EMPTIED_FAIL = 300
const PROP_KEY_REMOVAL_WARN = 50
const PROP_KEY_REMOVAL_FAIL = 300
const DELETIONS_WARN = 200
const DELETIONS_FAIL = 1000
const BULK_BUMP_WARN = 50
const AT_REST_PROPREF_WARN = 25
const DATA_INTEGRITY_STRICT = process.env.DATA_INTEGRITY_STRICT === '1'

// --- Attachment upload volume (storage.objects) ----------------------------
// Attachment bytes live in the `attachments` Storage bucket (supabase/migrations/
// 20260625000000_add_attachments_storage.sql), NOT in a synced table. Each
// object is <workspace_id>/<content-key>; storage.objects carries `owner`/
// `owner_id` (the uploading user), `created_at` (immutable — UPDATE is RLS-denied
// so re-uploads 409, making created_at a true upload timestamp), and
// `metadata->>'size'` (the stored byte length — CIPHERTEXT size for e2ee, and the
// ONLY server-readable size: the media block's `media:size` property is encrypted
// at rest in e2ee workspaces). We watch two things per user, both over LIVE
// objects (storage.objects holds only currently-present rows; deletes remove them):
//   * total — cumulative bytes a user has stored right now (storage-cost backstop)
//   * rate  — bytes of NEW live objects a user created in the rolling window
//             (burst / runaway / the documented member storage-DoS lever)
// WARN-by-default like the L5 detectors; FAIL is the abuse/runaway page. Reads
// the privileged pooler role, which sees all rows (same cross-tenant assumption
// the L5 blocks_history detectors already rely on); if RLS ever hid rows the
// query would return empty, not error — a blind spot shared with L5.
//
// BLIND SPOT — upload-churn that self-cleans before the probe. Both detectors
// read live objects, so a user who uploads a burst and DELETES the keys (writers
// may delete — see the RLS migration) before the hourly cron leaves no rows and
// trips nothing. This is by design, not a gap to plug here: what these guard is
// durable storage cost, and bytes deleted before the probe cost no durable
// storage — there is nothing to alert on. What it does NOT catch is pure
// upload-bandwidth churn (repeated upload+delete). The only append-only source
// is blocks_history (media-block inserts), but the byte size lives in `media:size`
// inside the encrypted properties_json, so for e2ee workspaces that yields a
// per-window media-creation COUNT, not bytes — a separate detector with its own
// thresholds, deliberately not built here.
//
// STARTER thresholds — NOT yet baselined against live fleet upload volume (the
// L5 thresholds were calibrated against 48h of cron runs; do the same here).
// Each run's JSON snapshot reports per-user MB, so watch a few runs and tune so
// normal heavy editing stays green. Sized for a small fleet on Supabase Pro
// (100 GB storage included); attachments live in S3, separate from the DB-disk
// backstop (db_size) — so these are an independent budget.
const ATTACHMENT_RATE_WINDOW_MIN = 90
const ATTACH_TOTAL_WARN_MB = 1000
const ATTACH_TOTAL_FAIL_MB = 5000
const ATTACH_RATE_WARN_MB = 200
const ATTACH_RATE_FAIL_MB = 1000

const uri = process.env.SUPABASE_POOLER_URI
const supabaseUrl = process.env.SUPABASE_URL
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY

if (!uri) {
  console.error('SUPABASE_POOLER_URI is required')
  process.exit(2)
}

const result = {
  timestamp: new Date().toISOString(),
  supabase_url: supabaseUrl ?? null,
  checks: {},
  warnings: [],
  failures: [],
}

const fail = (name, msg) => result.failures.push({ check: name, msg })
const warn = (name, msg) => result.warnings.push({ check: name, msg })

async function probeEndpoint(name, url, headers, { acceptStatuses = [200], failName }) {
  const start = Date.now()
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
    const elapsed_ms = Date.now() - start
    const ok = acceptStatuses.includes(res.status)
    result.checks[name] = { status: ok ? 'pass' : 'fail', http: res.status, elapsed_ms }
    if (!ok) fail(failName ?? name, `HTTP ${res.status} (expected one of ${acceptStatuses.join(',')})`)
  } catch (e) {
    result.checks[name] = { status: 'error', error: String(e), elapsed_ms: Date.now() - start }
    fail(failName ?? name, `request failed: ${e.message}`)
  }
}

async function checkServiceEndpoints() {
  if (!supabaseUrl || !supabaseAnonKey) {
    result.checks.service_endpoints = { status: 'skip', reason: 'missing SUPABASE_URL or SUPABASE_ANON_KEY' }
    return
  }
  const authHeaders = { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` }
  await Promise.all([
    // PostgREST — empty SELECT against a known table. RLS returns [] for anon, but the API responding 200 proves PostgREST is up.
    probeEndpoint('postgrest', `${supabaseUrl}/rest/v1/blocks?select=id&limit=0`, authHeaders, { failName: 'postgrest' }),
    // Auth — public health endpoint, anon key sufficient.
    probeEndpoint('auth', `${supabaseUrl}/auth/v1/health`, { apikey: supabaseAnonKey }, { failName: 'auth' }),
  ])
}

async function runDbChecks(client) {
  // Writability — the single most important signal. When the disk fills (or the
  // project is otherwise locked) Supabase flips the DB to read-only: every SELECT
  // still succeeds, so a read-only probe stays green while writes are dead. Check
  // the flag directly. pg_is_in_recovery() catches the related "landed on a
  // replica / in recovery" case.
  const rw = (await client.query(`
    select current_setting('default_transaction_read_only') as read_only,
           pg_is_in_recovery() as in_recovery
  `)).rows[0]
  const readOnly = rw.read_only === 'on'
  result.checks.writable = { status: 'pass', read_only: readOnly, in_recovery: rw.in_recovery }
  if (readOnly || rw.in_recovery) {
    result.checks.writable.status = 'fail'
    if (readOnly) fail('writable', 'database is in read-only mode (default_transaction_read_only=on) — disk full or project locked')
    if (rw.in_recovery) fail('writable', 'database is in recovery (pg_is_in_recovery()=true) — not the writable primary')
  }

  // Replication slots — main PowerSync leak indicator
  const slots = (await client.query(`
    select slot_name, slot_type, plugin, active,
           confirmed_flush_lsn, restart_lsn,
           pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) as lag_bytes
    from pg_replication_slots
  `)).rows
  const logicalSlots = slots.filter((s) => s.slot_type === 'logical')
  result.checks.replication_slots = {
    status: 'pass',
    count: slots.length,
    logical_count: logicalSlots.length,
    slots: slots.map((s) => ({
      // Redacted: slot names embed the PowerSync instance id, which is not in
      // the public repo. Keep type/active/lag (the actionable health fields).
      name: redactId(s.slot_name),
      type: s.slot_type,
      plugin: s.plugin,
      active: s.active,
      lag_bytes: s.lag_bytes == null ? null : Number(s.lag_bytes),
    })),
  }
  if (logicalSlots.length < EXPECTED_LOGICAL_SLOTS_MIN) {
    result.checks.replication_slots.status = 'fail'
    fail('replication_slots', `expected >=${EXPECTED_LOGICAL_SLOTS_MIN} logical slot, found ${logicalSlots.length}`)
  } else if (logicalSlots.length > EXPECTED_LOGICAL_SLOTS_MAX) {
    result.checks.replication_slots.status = 'fail'
    fail('replication_slots', `expected <=${EXPECTED_LOGICAL_SLOTS_MAX} logical slot, found ${logicalSlots.length}: ${logicalSlots.map((s) => redactId(s.slot_name)).join(', ')}`)
  }
  for (const s of logicalSlots) {
    if (!s.active) {
      result.checks.replication_slots.status = 'fail'
      fail('replication_slots', `slot ${redactId(s.slot_name)} is inactive`)
    }
  }

  // pg_logical/snapshots — direct measure of the bloat we just got bitten by
  const snap = (await client.query(`
    select count(*)::int as count, coalesce(sum(size), 0)::bigint as bytes
    from pg_ls_logicalsnapdir()
  `)).rows[0]
  const snapMb = Number(snap.bytes) / 1024 / 1024
  result.checks.pg_logical_snapshots = { status: 'pass', count: snap.count, size_mb: round2(snapMb) }
  if (snapMb >= SNAPSHOT_FAIL_MB) {
    result.checks.pg_logical_snapshots.status = 'fail'
    fail('pg_logical_snapshots', `${round2(snapMb)} MB exceeds ${SNAPSHOT_FAIL_MB} MB`)
  } else if (snapMb >= SNAPSHOT_WARN_MB) {
    result.checks.pg_logical_snapshots.status = 'warn'
    warn('pg_logical_snapshots', `${round2(snapMb)} MB exceeds ${SNAPSHOT_WARN_MB} MB`)
  }

  // pg_logical/mappings — related artifact, grows with active subscribers
  const mapDir = (await client.query(`
    select count(*)::int as count, coalesce(sum(size), 0)::bigint as bytes
    from pg_ls_logicalmapdir()
  `)).rows[0]
  const mapMb = Number(mapDir.bytes) / 1024 / 1024
  result.checks.pg_logical_mappings = { status: 'pass', count: mapDir.count, size_mb: round2(mapMb) }
  if (mapMb >= MAPPING_FAIL_MB) {
    result.checks.pg_logical_mappings.status = 'fail'
    fail('pg_logical_mappings', `${round2(mapMb)} MB exceeds ${MAPPING_FAIL_MB} MB`)
  } else if (mapMb >= MAPPING_WARN_MB) {
    result.checks.pg_logical_mappings.status = 'warn'
    warn('pg_logical_mappings', `${round2(mapMb)} MB exceeds ${MAPPING_WARN_MB} MB`)
  }

  // Temp files left over from failed/spilled queries
  const tmp = (await client.query(`
    select count(*)::int as count, coalesce(sum(size), 0)::bigint as bytes
    from pg_ls_tmpdir()
  `)).rows[0]
  const tmpMb = Number(tmp.bytes) / 1024 / 1024
  result.checks.pgsql_tmp = { status: 'pass', count: tmp.count, size_mb: round2(tmpMb) }
  if (tmpMb >= TMPDIR_FAIL_MB) {
    result.checks.pgsql_tmp.status = 'fail'
    fail('pgsql_tmp', `${round2(tmpMb)} MB exceeds ${TMPDIR_FAIL_MB} MB`)
  }

  // WAL — fine-grained per-file accounting; raw size is informational, growth pattern is what matters
  const wal = (await client.query(`
    select count(*)::int as files, coalesce(sum(size), 0)::bigint as bytes
    from pg_ls_waldir()
  `)).rows[0]
  const walMb = Number(wal.bytes) / 1024 / 1024
  result.checks.wal = { status: 'pass', files: wal.files, size_mb: round2(walMb) }
  if (walMb >= WAL_FAIL_MB) {
    result.checks.wal.status = 'fail'
    fail('wal', `${round2(walMb)} MB exceeds ${WAL_FAIL_MB} MB`)
  } else if (walMb >= WAL_WARN_MB) {
    result.checks.wal.status = 'warn'
    warn('wal', `${round2(walMb)} MB exceeds ${WAL_WARN_MB} MB`)
  }

  // DB size — backstop against unbounded growth toward the disk ceiling. Still
  // feeds the disk-reconciliation summary; now also thresholded (see constants).
  const dbSize = (await client.query(`select pg_database_size('postgres')::bigint as bytes`)).rows[0]
  const dbMb = Number(dbSize.bytes) / 1024 / 1024
  result.checks.db_size = { status: 'pass', size_mb: round2(dbMb) }
  if (dbMb >= DB_SIZE_FAIL_MB) {
    result.checks.db_size.status = 'fail'
    fail('db_size', `${round2(dbMb)} MB exceeds ${DB_SIZE_FAIL_MB} MB`)
  } else if (dbMb >= DB_SIZE_WARN_MB) {
    result.checks.db_size.status = 'warn'
    warn('db_size', `${round2(dbMb)} MB exceeds ${DB_SIZE_WARN_MB} MB`)
  }

  // Connections — Free-tier 60-connection cap is easy to hit
  const conn = (await client.query(`
    select
      (select setting::int from pg_settings where name = 'max_connections') as max,
      (select count(*)::int from pg_stat_activity) as total,
      (select count(*)::int from pg_stat_activity where state = 'active') as active,
      (select count(*)::int from pg_stat_activity where state = 'idle') as idle
  `)).rows[0]
  const connPct = conn.total / conn.max
  result.checks.connections = { status: 'pass', max: conn.max, total: conn.total, active: conn.active, idle: conn.idle, pct: round2(connPct) }
  if (connPct >= CONNECTIONS_FAIL_PCT) {
    result.checks.connections.status = 'fail'
    fail('connections', `${conn.total}/${conn.max} connections (${Math.round(connPct * 100)}%)`)
  } else if (connPct >= CONNECTIONS_WARN_PCT) {
    result.checks.connections.status = 'warn'
    warn('connections', `${conn.total}/${conn.max} connections (${Math.round(connPct * 100)}%)`)
  }

  // Idle-in-transaction — pins WAL even when the slot is fine
  const idleTx = (await client.query(`
    select count(*)::int as count,
           coalesce(max(extract(epoch from now() - xact_start))::bigint, 0) as longest_seconds
    from pg_stat_activity
    where state = 'idle in transaction'
       or state = 'idle in transaction (aborted)'
  `)).rows[0]
  result.checks.idle_in_transaction = { status: 'pass', count: idleTx.count, longest_seconds: Number(idleTx.longest_seconds) }
  if (Number(idleTx.longest_seconds) >= IDLE_IN_TX_FAIL_SECONDS) {
    result.checks.idle_in_transaction.status = 'fail'
    fail('idle_in_transaction', `longest idle-in-tx is ${Number(idleTx.longest_seconds)}s`)
  }

  // Autovacuum staleness — only alert when there's bloat (dead tuples) and the
  // last vacuum is old. Tables that have never been vacuumed because they're
  // quiet aren't a problem.
  const vac = (await client.query(`
    select schemaname || '.' || relname as table,
           n_dead_tup,
           n_live_tup,
           greatest(last_autovacuum, last_vacuum) as last_run
    from pg_stat_user_tables
    where schemaname = 'public'
  `)).rows
  const now = Date.now()
  const tableAges = vac.map((r) => ({
    table: r.table,
    dead_tup: Number(r.n_dead_tup),
    live_tup: Number(r.n_live_tup),
    last_run: r.last_run ? r.last_run.toISOString() : null,
    hours_since: r.last_run ? (now - new Date(r.last_run).getTime()) / 3600000 : null,
  }))
  const stale = tableAges.find((t) => t.dead_tup > 1000 && (t.hours_since == null || t.hours_since > VACUUM_WARN_HOURS))
  // Redact table names in the public log: this query enumerates ALL public
  // tables (it's what surfaced an ad-hoc backup table's existence). App-table
  // names are already public via the repo's migrations, so the win is hiding
  // any non-standard/ad-hoc table; hashing uniformly avoids one table standing
  // out. Tuple counts stay (needed to judge vacuum health). Map a hash back to
  // a name by re-running pg_stat_user_tables with privileged access.
  result.checks.autovacuum = {
    status: stale ? 'warn' : 'pass',
    tables: tableAges.map((t) => ({ ...t, table: redactId(t.table) })),
  }
  if (stale) {
    warn('autovacuum', `${redactId(stale.table)} has ${stale.dead_tup} dead tuples and last vacuum was ${stale.hours_since == null ? 'never' : Math.round(stale.hours_since) + 'h ago'}`)
  }

  // RLS schema-drift regression check
  const rls = (await client.query(`
    select c.relname as table, c.relrowsecurity as enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname = ANY($1::text[])
  `, [EXPECTED_RLS_TABLES])).rows
  const missing = EXPECTED_RLS_TABLES.filter((t) => !rls.find((r) => r.table === t))
  const disabled = rls.filter((r) => !r.enabled).map((r) => r.table)
  result.checks.rls = { status: 'pass', tables: rls, missing, disabled }
  if (missing.length) {
    result.checks.rls.status = 'fail'
    fail('rls', `expected tables missing: ${missing.join(', ')}`)
  }
  if (disabled.length) {
    result.checks.rls.status = 'fail'
    fail('rls', `RLS disabled on: ${disabled.join(', ')}`)
  }

  // Publication contents — schema-drift regression check
  const pubTables = (await client.query(`
    select tablename from pg_publication_tables where pubname = 'powersync' order by tablename
  `)).rows.map((r) => r.tablename)
  const expected = [...EXPECTED_PUB_TABLES].sort()
  const actual = [...pubTables].sort()
  const driftAdd = actual.filter((t) => !expected.includes(t))
  const driftRemove = expected.filter((t) => !actual.includes(t))
  result.checks.publication = { status: 'pass', expected, actual }
  if (driftAdd.length || driftRemove.length) {
    result.checks.publication.status = 'fail'
    if (driftAdd.length) fail('publication', `unexpected tables in publication: ${driftAdd.join(', ')}`)
    if (driftRemove.length) fail('publication', `missing tables from publication: ${driftRemove.join(', ')}`)
  }

  result.checks.summary = {
    tracked_mb: round2(dbMb + walMb + snapMb + mapMb + tmpMb),
    components_mb: { db: round2(dbMb), wal: round2(walMb), snapshots: round2(snapMb), mappings: round2(mapMb), tmp: round2(tmpMb) },
  }
}

const SEV_RANK = { pass: 0, warn: 1, error: 1, fail: 2 }
const maxStatus = (a, b) => (SEV_RANK[b] > SEV_RANK[a] ? b : a)

// Decide a status for one (actor, workspace) group count and record it on the
// shared result. STRICT promotes a WARN to a FAIL (and thus to the email
// channel). Returns the per-group status for rollup.
function integrityThreshold(check, label, count, { warnAt, failAt }) {
  if (failAt != null && count >= failAt) {
    fail(`integrity.${check}`, `${label}: ${count} >= ${failAt}`)
    return 'fail'
  }
  if (warnAt != null && count >= warnAt) {
    if (DATA_INTEGRITY_STRICT) {
      fail(`integrity.${check}`, `${label}: ${count} >= ${warnAt} (DATA_INTEGRITY_STRICT)`)
      return 'fail'
    }
    warn(`integrity.${check}`, `${label}: ${count} >= ${warnAt}`)
    return 'warn'
  }
  return 'pass'
}

// L5 — blocks_history anomaly detectors. Each detector is wrapped so a SQL
// error degrades that one detector to `error` (and a warn) without aborting the
// rest of the probe or reading as clean. The window is a single interval shared
// by all rate detectors so the snapshot is internally consistent.
async function runDataIntegrityChecks(client) {
  const integrity = { status: 'pass', window_min: INTEGRITY_WINDOW_MIN, strict: DATA_INTEGRITY_STRICT, detectors: {} }
  result.checks.data_integrity = integrity
  const win = [INTEGRITY_WINDOW_MIN]

  const detector = async (name, fn) => {
    try {
      const out = await fn()
      integrity.detectors[name] = out
      integrity.status = maxStatus(integrity.status, out.status)
    } catch (e) {
      integrity.detectors[name] = { status: 'error', error: String(e?.message ?? e) }
      integrity.status = maxStatus(integrity.status, 'error')
      // An errored detector must not read as clean — surface it (warn, no email).
      warn(`integrity.${name}`, `detector errored: ${e?.message ?? e}`)
    }
  }

  // (1) Mass references-only strip — U events that emptied a non-empty ref set
  // to `[]`, keyed on the count that is STILL empty at window end (durable), so
  // a self-healing burst is at most a WARN, not a FAIL. (incident #1, 06-09)
  await detector('references_emptied', async () => {
    const rows = (await client.query(`
      WITH ref_changes AS (
        SELECT h.block_id, h.workspace_id, h.actor,
               h.before_diff->>'references_json' AS before_refs,
               h.after_diff->>'references_json'  AS after_refs
        FROM public.blocks_history h
        WHERE h.event_time >= now() - ($1::int * interval '1 minute')
          AND h.op = 'U'
          AND 'references_json' = ANY(h.changed_columns)
      ),
      emptied AS (
        SELECT DISTINCT block_id, workspace_id, actor
        FROM ref_changes
        WHERE before_refs IS NOT NULL
          AND before_refs NOT IN ('[]', '')
          AND after_refs = '[]'
      )
      SELECT e.actor, e.workspace_id,
             count(*)::int AS emptied,
             count(*) FILTER (WHERE b.id IS NOT NULL AND b.references_json = '[]')::int AS durable
      FROM emptied e
      LEFT JOIN public.blocks b ON b.id = e.block_id AND b.workspace_id = e.workspace_id
      GROUP BY e.actor, e.workspace_id
      ORDER BY durable DESC
    `, win)).rows
    let status = 'pass'
    for (const r of rows) {
      status = maxStatus(status, integrityThreshold('references_emptied',
        `actor=${redactId(r.actor) ?? 'null'} ws=${redactId(r.workspace_id)} refs emptied-and-still-empty`,
        r.durable, { warnAt: REFS_EMPTIED_WARN, failAt: REFS_EMPTIED_FAIL }))
    }
    return { status, groups: rows.map((r) => ({ actor: redactId(r.actor), workspace_id: redactId(r.workspace_id), emptied: r.emptied, durable: r.durable })) }
  })

  // (1b) References shrunk — informational only (routine link removal shrinks
  // ref sets, so this is noisy by design). Never thresholds; a slow/partial
  // strip is caught at rest by the curated check below, not here.
  await detector('references_shrunk', async () => {
    const row = (await client.query(`
      SELECT count(*)::int AS shrunk
      FROM public.blocks_history h
      WHERE h.event_time >= now() - ($1::int * interval '1 minute')
        AND h.op = 'U'
        AND 'references_json' = ANY(h.changed_columns)
        AND h.before_diff->>'references_json' LIKE '[%'
        AND h.after_diff->>'references_json'  LIKE '[%'
        AND jsonb_array_length((h.after_diff->>'references_json')::jsonb)
          < jsonb_array_length((h.before_diff->>'references_json')::jsonb)
    `, win)).rows[0]
    return { status: 'pass', informational: true, shrunk: row.shrunk }
  })

  // (2) Mass property-key removal — U events where properties_json lost keys.
  // Guarded by LIKE '{%' so e2ee ciphertext is skipped, not cast-failed.
  await detector('property_key_removal', async () => {
    const rows = (await client.query(`
      SELECT h.actor, h.workspace_id, count(*)::int AS removals
      FROM public.blocks_history h
      WHERE h.event_time >= now() - ($1::int * interval '1 minute')
        AND h.op = 'U'
        AND 'properties_json' = ANY(h.changed_columns)
        AND h.before_diff->>'properties_json' LIKE '{%'
        AND h.after_diff->>'properties_json'  LIKE '{%'
        AND (SELECT count(*) FROM jsonb_object_keys((h.after_diff->>'properties_json')::jsonb))
          < (SELECT count(*) FROM jsonb_object_keys((h.before_diff->>'properties_json')::jsonb))
      GROUP BY h.actor, h.workspace_id
      ORDER BY removals DESC
    `, win)).rows
    let status = 'pass'
    for (const r of rows) {
      status = maxStatus(status, integrityThreshold('property_key_removal',
        `actor=${redactId(r.actor) ?? 'null'} ws=${redactId(r.workspace_id)} prop-key removals`,
        r.removals, { warnAt: PROP_KEY_REMOVAL_WARN, failAt: PROP_KEY_REMOVAL_FAIL }))
    }
    return { status, groups: rows.map((r) => ({ actor: redactId(r.actor), workspace_id: redactId(r.workspace_id), removals: r.removals })) }
  })

  // (3) Mass deletions — D (hard) + soft_delete per actor in window.
  await detector('deletions', async () => {
    const rows = (await client.query(`
      SELECT h.actor, h.workspace_id,
             count(*) FILTER (WHERE h.op = 'D')::int AS hard,
             count(*) FILTER (WHERE h.semantic_op = 'soft_delete')::int AS soft,
             count(*)::int AS total
      FROM public.blocks_history h
      WHERE h.event_time >= now() - ($1::int * interval '1 minute')
        AND (h.op = 'D' OR h.semantic_op = 'soft_delete')
      GROUP BY h.actor, h.workspace_id
      ORDER BY total DESC
    `, win)).rows
    let status = 'pass'
    for (const r of rows) {
      status = maxStatus(status, integrityThreshold('deletions',
        `actor=${redactId(r.actor) ?? 'null'} ws=${redactId(r.workspace_id)} deletions`,
        r.total, { warnAt: DELETIONS_WARN, failAt: DELETIONS_FAIL }))
    }
    return { status, groups: rows.map((r) => ({ actor: redactId(r.actor), workspace_id: redactId(r.workspace_id), hard: r.hard, soft: r.soft, total: r.total })) }
  })

  // (4) Bulk metadata-only bump — changed_columns ⊆ {updated_at, user_updated_at,
  // updated_by} with updated_at present (the recovery-touch shape). Includes
  // updated_by because a recovery done the recommended way (through repo.tx)
  // stamps it alongside updated_at/user_updated_at — without it this would only
  // catch a raw server-side updated_at touch, not the tx path the L6 harness
  // steers toward. Any bulk occurrence warns; per #4 it deserves a human glance.
  await detector('bulk_updated_at_bump', async () => {
    const rows = (await client.query(`
      SELECT h.actor, h.workspace_id, count(*)::int AS bumps
      FROM public.blocks_history h
      WHERE h.event_time >= now() - ($1::int * interval '1 minute')
        AND h.op = 'U'
        AND h.changed_columns <@ ARRAY['updated_at','user_updated_at','updated_by']::text[]
        AND 'updated_at' = ANY(h.changed_columns)
      GROUP BY h.actor, h.workspace_id
      ORDER BY bumps DESC
    `, win)).rows
    let status = 'pass'
    for (const r of rows) {
      status = maxStatus(status, integrityThreshold('bulk_updated_at_bump',
        `actor=${redactId(r.actor) ?? 'null'} ws=${redactId(r.workspace_id)} metadata-only bumps`,
        r.bumps, { warnAt: BULK_BUMP_WARN }))
    }
    return { status, groups: rows.map((r) => ({ actor: redactId(r.actor), workspace_id: redactId(r.workspace_id), bumps: r.bumps })) }
  })

  // (5) At-rest property-ref inconsistency — curated high-value props whose
  // value is present in properties_json but whose projected ref is absent from
  // references_json. The proven 06-09 detection query; over the live table, so
  // it catches durable residuals a rate detector misses. Plaintext-only.
  await detector('at_rest_property_ref', async () => {
    const conds = CURATED_REF_PROPS.map((_, i) =>
      `(b.properties_json LIKE $${i * 2 + 1} AND b.references_json NOT LIKE $${i * 2 + 2})`).join(' OR ')
    const params = CURATED_REF_PROPS.flatMap((p) => [`%"${p}"%`, `%"sourceField":"${p}"%`])
    const rows = (await client.query(`
      SELECT b.workspace_id, count(*)::int AS inconsistent
      FROM public.blocks b
      WHERE b.deleted IS NOT TRUE
        AND (${conds})
      GROUP BY b.workspace_id
      ORDER BY inconsistent DESC
    `, params)).rows
    const total = rows.reduce((a, r) => a + r.inconsistent, 0)
    const status = integrityThreshold('at_rest_property_ref',
      `props=[${CURATED_REF_PROPS.join(',')}] value-present/ref-absent`,
      total, { warnAt: AT_REST_PROPREF_WARN })
    return {
      status,
      props: CURATED_REF_PROPS,
      total,
      by_workspace: rows.map((r) => ({ workspace_id: redactId(r.workspace_id), inconsistent: r.inconsistent })),
    }
  })
}

// Attachment upload volume — per-user cumulative total + per-user rolling-window
// rate over the `attachments` Storage bucket. storage.objects is metadata only
// (the bytes are in S3), readable by the privileged pooler role. Skips cleanly
// when the bucket table is absent (Storage not initialised on this stack — e.g.
// a local `supabase start` before the Storage container boots). PII (owner,
// workspace) is redacted: the snapshot lands in a PUBLIC Actions log.
async function runAttachmentChecks(client) {
  const attachments = { status: 'pass', window_min: ATTACHMENT_RATE_WINDOW_MIN, detectors: {} }
  result.checks.attachments = attachments

  if ((await client.query(`select to_regclass('storage.objects') as t`)).rows[0].t == null) {
    attachments.status = 'skip'
    attachments.reason = 'storage.objects not present (Storage not initialised)'
    return
  }

  const detector = async (name, fn) => {
    try {
      const out = await fn()
      attachments.detectors[name] = out
      attachments.status = maxStatus(attachments.status, out.status)
    } catch (e) {
      attachments.detectors[name] = { status: 'error', error: String(e?.message ?? e) }
      attachments.status = maxStatus(attachments.status, 'error')
      // An errored detector must not read as clean — surface it (warn, no email).
      warn(`attachments.${name}`, `detector errored: ${e?.message ?? e}`)
    }
  }

  // MB WARN/FAIL for one per-user group; pushes the alert and returns the status.
  const mbThreshold = (check, label, mb, { warnAt, failAt }) => {
    if (failAt != null && mb >= failAt) {
      fail(`attachments.${check}`, `${label}: ${round2(mb)} MB >= ${failAt} MB`)
      return 'fail'
    }
    if (warnAt != null && mb >= warnAt) {
      warn(`attachments.${check}`, `${label}: ${round2(mb)} MB >= ${warnAt} MB`)
      return 'warn'
    }
    return 'pass'
  }

  const byUser = (rows, check, label, thresholds) => {
    let status = 'pass'
    const groups = rows.map((r) => {
      const mb = Number(r.bytes) / 1024 / 1024
      status = maxStatus(status, mbThreshold(check,
        `owner=${redactId(r.owner) ?? 'null'} ${label}`, mb, thresholds))
      return { owner: redactId(r.owner), objects: r.objects, size_mb: round2(mb) }
    })
    return { status, groups }
  }

  // (1) Per-user TOTAL stored bytes — cumulative footprint across all objects the
  // user owns. Reclaimed objects (§16 GC) drop out, so this tracks the live
  // storage cost a user is responsible for, not lifetime upload.
  await detector('total_per_user', async () =>
    byUser((await client.query(`
      SELECT coalesce(o.owner_id, o.owner::text) AS owner,
             count(*)::int AS objects,
             coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint AS bytes
      FROM storage.objects o
      WHERE o.bucket_id = 'attachments'
      GROUP BY 1
      ORDER BY bytes DESC
    `)).rows, 'total_per_user', 'total stored',
      { warnAt: ATTACH_TOTAL_WARN_MB, failAt: ATTACH_TOTAL_FAIL_MB }))

  // (2) Per-user RATE over the window — bytes of NEW live objects created in the
  // last 90m: the burst / runaway / storage-DoS signal. Window is 90m so
  // consecutive hourly runs overlap and never miss a burst between probes (same
  // reason the L5 window is 90m, not 60m). Counts only objects still live at
  // probe time (see BLIND SPOT above: upload+delete-before-cron self-cleans and
  // is intentionally not caught — deleted bytes cost no durable storage).
  await detector('rate_per_user', async () =>
    byUser((await client.query(`
      SELECT coalesce(o.owner_id, o.owner::text) AS owner,
             count(*)::int AS objects,
             coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint AS bytes
      FROM storage.objects o
      WHERE o.bucket_id = 'attachments'
        AND o.created_at >= now() - ($1::int * interval '1 minute')
      GROUP BY 1
      ORDER BY bytes DESC
    `, [ATTACHMENT_RATE_WINDOW_MIN])).rows, 'rate_per_user',
      `uploaded in ${ATTACHMENT_RATE_WINDOW_MIN}m`,
      { warnAt: ATTACH_RATE_WARN_MB, failAt: ATTACH_RATE_FAIL_MB }))
}

function round2(n) { return Math.round(n * 100) / 100 }

const client = new pg.Client({ connectionString: uri, ssl: { rejectUnauthorized: false } })

try {
  await client.connect()
  await Promise.all([runDbChecks(client), runDataIntegrityChecks(client), runAttachmentChecks(client), checkServiceEndpoints()])
} catch (e) {
  result.failures.push({ check: 'connection', msg: e.message })
} finally {
  try { await client.end() } catch {}
}

console.log(JSON.stringify(result, null, 2))

// WARN awareness: a warning does NOT fail the job (no page), so without this it
// would be invisible inside the JSON above. Emit each as a GitHub `::warning::`
// annotation (surfaces on the run page + the Actions list) plus a stderr block.
// FAILs additionally exit(1), which reds the job — that is the actual page.
const annotate = (kind, items) => {
  for (const it of items) console.log(`::${kind} title=${it.check}::${it.msg}`)
}
if (result.warnings.length > 0) {
  console.error('\nWARNINGS:')
  for (const w of result.warnings) console.error(`  [${w.check}] ${w.msg}`)
  annotate('warning', result.warnings)
}

if (result.failures.length > 0) {
  console.error('\nFAILURES:')
  for (const f of result.failures) console.error(`  [${f.check}] ${f.msg}`)
  annotate('error', result.failures)
  process.exit(1)
}
process.exit(0)
