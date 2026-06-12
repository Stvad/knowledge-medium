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
      name: s.slot_name,
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
    fail('replication_slots', `expected <=${EXPECTED_LOGICAL_SLOTS_MAX} logical slot, found ${logicalSlots.length}: ${logicalSlots.map((s) => s.slot_name).join(', ')}`)
  }
  for (const s of logicalSlots) {
    if (!s.active) {
      result.checks.replication_slots.status = 'fail'
      fail('replication_slots', `slot ${s.slot_name} is inactive`)
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
  result.checks.autovacuum = { status: stale ? 'warn' : 'pass', tables: tableAges }
  if (stale) {
    warn('autovacuum', `${stale.table} has ${stale.dead_tup} dead tuples and last vacuum was ${stale.hours_since == null ? 'never' : Math.round(stale.hours_since) + 'h ago'}`)
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

function round2(n) { return Math.round(n * 100) / 100 }

const client = new pg.Client({ connectionString: uri, ssl: { rejectUnauthorized: false } })

try {
  await client.connect()
  await Promise.all([runDbChecks(client), checkServiceEndpoints()])
} catch (e) {
  result.failures.push({ check: 'connection', msg: e.message })
} finally {
  try { await client.end() } catch {}
}

console.log(JSON.stringify(result, null, 2))

if (result.failures.length > 0) {
  console.error('\nFAILURES:')
  for (const f of result.failures) console.error(`  [${f.check}] ${f.msg}`)
  process.exit(1)
}
process.exit(0)
