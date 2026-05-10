#!/usr/bin/env node
// Hourly health probe for the Supabase project. Designed to be run from GitHub
// Actions cron; emits a JSON snapshot on stdout and exits non-zero on any fail
// threshold. Workflow failure is the alert channel.
//
// Required env: SUPABASE_POOLER_URI (IPv4 pooler — GH runners are IPv4-only).
// Optional env: SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF (enables the
// Management-API project-status check).
//
// Thresholds — keep in sync with comments in the monitoring memory note.

import pg from 'pg'

const SNAPSHOT_WARN_MB = 50
const SNAPSHOT_FAIL_MB = 200
const MAPPING_WARN_MB = 20
const MAPPING_FAIL_MB = 100
const TMPDIR_FAIL_MB = 100
const WAL_WARN_MB = 500
const WAL_FAIL_MB = 1500
const IDLE_IN_TX_FAIL_SECONDS = 60 * 60
const CONNECTIONS_WARN_PCT = 0.83
const CONNECTIONS_FAIL_PCT = 0.97
const VACUUM_WARN_HOURS = 48
const EXPECTED_RLS_TABLES = ['workspaces', 'workspace_members', 'workspace_invitations', 'blocks']
const EXPECTED_PUB_TABLES = ['blocks', 'workspace_members', 'workspaces']
const EXPECTED_LOGICAL_SLOTS_MIN = 1
const EXPECTED_LOGICAL_SLOTS_MAX = 1

const uri = process.env.SUPABASE_POOLER_URI
const accessToken = process.env.SUPABASE_ACCESS_TOKEN
const projectRef = process.env.SUPABASE_PROJECT_REF

if (!uri) {
  console.error('SUPABASE_POOLER_URI is required')
  process.exit(2)
}

const result = {
  timestamp: new Date().toISOString(),
  project_ref: projectRef ?? null,
  checks: {},
  warnings: [],
  failures: [],
}

const fail = (name, msg) => result.failures.push({ check: name, msg })
const warn = (name, msg) => result.warnings.push({ check: name, msg })

async function checkProjectStatus() {
  if (!accessToken || !projectRef) {
    result.checks.project_status = { status: 'skip', reason: 'missing token or ref' }
    return
  }
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      const body = await res.text()
      result.checks.project_status = { status: 'error', http: res.status, body: body.slice(0, 200) }
      fail('project_status', `Management API returned ${res.status}`)
      return
    }
    const data = await res.json()
    result.checks.project_status = { status: data.status === 'ACTIVE_HEALTHY' ? 'pass' : 'fail', value: data.status }
    if (data.status !== 'ACTIVE_HEALTHY') fail('project_status', `project status is ${data.status}`)
  } catch (e) {
    result.checks.project_status = { status: 'error', error: String(e) }
    fail('project_status', `fetch failed: ${e.message}`)
  }
}

async function runDbChecks(client) {
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

  // DB size — informational, used for disk reconciliation
  const dbSize = (await client.query(`select pg_database_size('postgres')::bigint as bytes`)).rows[0]
  const dbMb = Number(dbSize.bytes) / 1024 / 1024
  result.checks.db_size = { status: 'pass', size_mb: round2(dbMb) }

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
  await Promise.all([runDbChecks(client), checkProjectStatus()])
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
