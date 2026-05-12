/**
 * Production bootstrap for the new data layer (replaces
 * `src/data/repoInstance.ts`).
 *
 * Per-user PowerSync database — the database itself is the user
 * isolation boundary (no shared CRUD queue, no shared cache, no risk
 * of one session's pending uploads being retried under another user's
 * JWT). Sign-out clears the Supabase session but leaves the local DB
 * intact; sign-in as the same user reopens the same DB and unsynced
 * edits resume uploading. Sign-in as a different user opens a fresh
 * DB.
 *
 * What this DOES:
 *   - Open a `PowerSyncDatabase` keyed by user id
 *   - Run PowerSync's `init()` (sets up powersync_crud + ps_oplog)
 *   - Run the new client-side DDL: `blocks` + core indexes,
 *     workspaces + workspace_members tables/indexes,
 *     `CLIENT_SCHEMA_STATEMENTS` (tx_context, row_events,
 *     command_events, core side indexes, and triggers), then static
 *     data-plugin local schema contributions
 *   - Connect to the PowerSync server when `hasRemoteSyncConfig`
 *
 * What this does NOT do (vs. legacy):
 *   - No `block_event_context` / `block_events` tables (replaced by
 *     `tx_context` + `row_events` from clientSchema.ts)
 *   - No legacy CRUD-routing triggers (replaced by the 5 audit/upload
 *     triggers in clientSchema.ts that key on `tx_context.source`)
 *   - No `UndoRedoManager` (undo lands in a future stage; engine
 *     doesn't depend on it)
 */

import { PowerSyncDatabase, Schema, WASQLiteOpenFactory, WASQLiteVFS, createBaseLogger, LogLevel } from '@powersync/web'
import { createPowerSyncConnector, hasRemoteSyncConfig } from '@/services/powersync.ts'
import {
  BLOCKS_RAW_TABLE,
  CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
} from '@/data/blockSchema'
import {
  CREATE_WORKSPACES_TABLE_SQL,
  CREATE_WORKSPACE_MEMBERS_INDEX_SQL,
  CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
  WORKSPACES_RAW_TABLE,
  WORKSPACE_MEMBERS_RAW_TABLE,
} from '@/data/workspaceSchema'
import {
  CLIENT_SCHEMA_STATEMENTS,
  backfillBlockAliasesIfEmpty,
  backfillBlockTypesIfEmpty,
} from '@/data/internals/clientSchema'
import {
  applyLocalSchemaContributions,
  resolveLocalSchemaContributions,
} from '@/data/localSchema.ts'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.ts'

const appSchema = new Schema({})
appSchema.withRawTables({
  blocks: BLOCKS_RAW_TABLE,
  workspaces: WORKSPACES_RAW_TABLE,
  workspace_members: WORKSPACE_MEMBERS_RAW_TABLE,
})

// wa-sqlite's VFS caps pathnames at 64 chars (mxPathname in
// node_modules/@journeyapps/wa-sqlite/src/VFS.js). SQLite derives
// WAL/journal/shm paths from the dbFilename with suffixes up to ~10
// chars, so the base has to stay well under 64 or sqlite3_open_v2
// fails with "Filename too long" and no useful error. 7 (prefix) +
// 40 (user) + 3 (suffix) = 50 — safe headroom.
const MAX_USER_SEGMENT = 40

// v5 = back to IDBBatchAtomicVFS for the bucket-wipe diagnostic (see
// `buildPowerSyncDb` below). v4 was OPFSCoopSync; v3 was the original
// IDB layout. Each VFS bump gets a fresh filename so we don't reuse
// storage across backends (IDB and OPFS don't share state anyway, but
// the version bump keeps debug logs / OPFS-leftovers unambiguous).
export const dbFilenameForUser = (userId: string) => {
  const sanitized = userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_USER_SEGMENT)
  return `kmp-v5-${sanitized}.db`
}

const dbsByUser = new Map<string, PowerSyncDatabase>()
const initPromises = new Map<string, Promise<void>>()
let activeUserId: string | null = null
let connectChain: Promise<void> = Promise.resolve()

// DIAGNOSTIC: switched from OPFSCoopSyncVFS back to IDBBatchAtomicVFS
// to test whether the bucket-wipe-on-edit pattern is OPFS-specific.
// We saw the same wipe reproduce on a tiny (~40-op) workspace under
// OPFSCoopSync + Rust sync client, ruling out workspace size. If IDB
// shows the same wipe, the bug is in the Rust client / checkpoint
// path. If it doesn't, the bug lives in OPFS / wa-sqlite's interaction
// with the borrowed-connection pattern.
//
// IDBBatchAtomicVFS doesn't require a dedicated worker
// (`vfsRequiresDedicatedWorkers` returns false only for it — see
// node_modules/@powersync/web/lib/src/db/adapters/wa-sqlite/vfs.js),
// so the SharedSync worker can own the DB directly. We're keeping
// `enableMultiTabs: false` for now to hold one variable at a time;
// once we confirm IDB doesn't wipe, flipping to true should be safe.
//
// Trade-off vs OPFS: cold-page reads go through IndexedDB transactions
// instead of OPFS sync access handles — slower for big working sets.
// The 256 MiB cache_size (set in initializePowerSyncDb) absorbs most
// of that hit at steady state.
// DIAGNOSTIC: enable DEBUG-level PowerSync logging and tap console.*
// so every log line is captured into `window.__ps_log_buf` (a ring
// buffer). The agent runtime reads this back to correlate PowerSync's
// internal apply/checkpoint events with observed bucket wipes — no
// devtools console required. Remove once the bucket-wipe diagnostic
// is resolved.
const installPowerSyncLogCapture = () => {
  if (typeof window === 'undefined') return
  const win = window as unknown as { __ps_log_buf?: unknown[]; __ps_log_capture_installed?: boolean }
  if (win.__ps_log_capture_installed) return
  win.__ps_log_capture_installed = true

  // Set the GLOBAL js-logger default to DEBUG. Per `createLogger` in
  // node_modules/@powersync/common/lib/utils/Logger.js, named loggers
  // that aren't passed an explicit logLevel inherit from this default —
  // so flipping this single switch turns on every internal PowerSync
  // logger (sync-stream, bucket-storage, remote, etc.) at once.
  createBaseLogger().setLevel(LogLevel.DEBUG)

  const buf: { t: number; level: string; msg: string }[] = []
  win.__ps_log_buf = buf
  for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
      try {
        buf.push({
          t: Date.now(),
          level: method,
          msg: args.map(a => {
            if (a == null) return String(a)
            if (typeof a === 'string') return a
            try { return JSON.stringify(a).slice(0, 800) }
            catch { return String(a).slice(0, 800) }
          }).join(' '),
        })
        if (buf.length > 5000) buf.splice(0, buf.length - 5000)
      } catch { /* never let logging break */ }
      original(...args)
    }
  }
  buf.push({ t: Date.now(), level: 'info', msg: '[log-tap] PowerSync DEBUG capture installed' })
}

const buildPowerSyncDb = (userId: string) => {
  installPowerSyncLogCapture()
  return new PowerSyncDatabase({
    schema: appSchema,
    database: new WASQLiteOpenFactory({
      dbFilename: dbFilenameForUser(userId),
      vfs: WASQLiteVFS.IDBBatchAtomicVFS,
    }),
    flags: {
      enableMultiTabs: false,
    },
  })
}

export const getPowerSyncDb = (userId: string): PowerSyncDatabase => {
  const existing = dbsByUser.get(userId)
  if (existing) return existing
  const db = buildPowerSyncDb(userId)
  dbsByUser.set(userId, db)
  return db
}

// `useRemoteSync` is the runtime gate (defaults to the build-time
// `hasRemoteSyncConfig`). Callers pass `false` when the user opted into
// local-only mode at login — in that case we still init the local DB +
// triggers but skip `db.connect()` so we never make a Supabase auth or
// PowerSync sync request from this session.
export const ensurePowerSyncReady = async (
  userId: string,
  useRemoteSync: boolean = hasRemoteSyncConfig,
) => {
  const db = getPowerSyncDb(userId)

  let initPromise = initPromises.get(userId)
  if (!initPromise) {
    initPromise = initializePowerSyncDb(db)
    initPromises.set(userId, initPromise)
  }
  await initPromise

  if (!useRemoteSync) {
    return
  }

  if (activeUserId === userId) {
    return
  }

  const previousUserId = activeUserId
  activeUserId = userId

  // Run disconnect+connect serially so we don't race two connect
  // attempts. Don't await the chain — connect can take a while and
  // we want render to proceed against the local cache.
  connectChain = connectChain
    .then(async () => {
      if (previousUserId && previousUserId !== userId) {
        const previousDb = dbsByUser.get(previousUserId)
        if (previousDb) {
          await previousDb.disconnect()
        }
      }
      await db.connect(createPowerSyncConnector())
    })
    .catch((error) => {
      console.error(`PowerSync background connect failed for ${userId}:`, error)
    })
}

const initializePowerSyncDb = async (powerSyncDb: PowerSyncDatabase) => {
  await powerSyncDb.init()

  // No `PRAGMA journal_mode=WAL`: none of wa-sqlite's PowerSync-bundled
  // VFSes implement xShmMap (the wal-index shared-memory primitive
  // SQLite needs for native WAL), so SQLite silently keeps rollback
  // journal mode. Re-evaluate if PowerSync ever ships a WAL-capable
  // browser VFS.

  // Cache + temp-store tuning. SQLite's default `cache_size` is 2000
  // pages = ~8 MB — fine for tiny DBs, catastrophic for users with
  // import-heavy workspaces (250k blocks ≈ 700 MB on-disk). Each cold
  // page becomes a synchronous OPFS read on the worker thread, so a
  // page-open's load + ancestors + children + backlinks queries all
  // serialize behind cold-page I/O. Raising the cache to 256 MiB lets
  // the hot index + active-page footprint live in worker RAM, dropping
  // most reads to memory speed after a brief warmup.
  //
  // Negative value = absolute KiB (positive = page count, which depends
  // on page_size). 262144 KiB = 256 MiB.
  //
  // Trade: ~256 MiB resident browser memory while the app is open. On
  // small DBs SQLite only allocates pages it touches, so steady-state
  // memory tracks the actual working set (much less than the cap).
  //
  // `temp_store = MEMORY` keeps temp B-trees (DISTINCT, ORDER BY,
  // recursive CTEs) off OPFS — they're transient and don't need to
  // survive a crash, and the OPFS VFS doesn't perform well as a temp
  // store anyway.
  await powerSyncDb.execute('PRAGMA cache_size = -262144')
  await powerSyncDb.execute('PRAGMA temp_store = MEMORY')

  // ── blocks + its indexes ──
  await powerSyncDb.execute(CREATE_BLOCKS_TABLE_SQL)
  await powerSyncDb.execute(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL)
  await powerSyncDb.execute(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)

  // ── workspaces + workspace_members ──
  await powerSyncDb.execute(CREATE_WORKSPACES_TABLE_SQL)
  await powerSyncDb.execute(CREATE_WORKSPACE_MEMBERS_TABLE_SQL)
  await powerSyncDb.execute(CREATE_WORKSPACE_MEMBERS_INDEX_SQL)

  // ── tx_context, row_events, command_events, block_aliases + core
  // triggers ── (5 audit/upload, 2 workspace-invariant, 3 alias-index.)
  // Statements include
  // CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / CREATE
  // TRIGGER IF NOT EXISTS so re-running is a no-op against an
  // already-bootstrapped dev database.
  for (const stmt of CLIENT_SCHEMA_STATEMENTS) {
    await powerSyncDb.execute(stmt)
  }

  // One-shot side-index backfills for users upgrading from a
  // pre-index schema. Steady-state startups noop on a single LIMIT 1
  // probe of `client_schema_state`.
  const backfillDb = {
    execute: (sql: string) => powerSyncDb.execute(sql),
    getOptional: async <T,>(sql: string) => {
      const row = await powerSyncDb.getOptional<T>(sql)
      return row ?? null
    },
  }
  await backfillBlockAliasesIfEmpty(backfillDb)
  await backfillBlockTypesIfEmpty(backfillDb)
  await applyLocalSchemaContributions(
    backfillDb,
    resolveLocalSchemaContributions(staticDataExtensions),
  )
}
