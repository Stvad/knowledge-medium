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
 *   - Run the new client-side DDL: `blocks` + indexes (parent_order,
 *     workspace_active, workspace_with_references, workspace_type),
 *     workspaces + workspace_members tables/indexes, then
 *     `CLIENT_SCHEMA_STATEMENTS` (tx_context, row_events,
 *     command_events, side indexes, and triggers)
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

import { PowerSyncDatabase, Schema, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web'
import { createPowerSyncConnector, hasRemoteSyncConfig } from '@/services/powersync.ts'
import {
  BLOCKS_RAW_TABLE,
  CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
  CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL,
  CREATE_BLOCKS_WORKSPACE_TYPE_INDEX_SQL,
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
  backfillBlockReferencesIfEmpty,
} from '@/data/internals/clientSchema'

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

// v4 = OPFS migration. Old IDB-backed kmp-v3-* databases are abandoned
// (alpha, no migration). OPFSCoopSyncVFS stores each database as a real
// file at OPFS root.
export const dbFilenameForUser = (userId: string) => {
  const sanitized = userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_USER_SEGMENT)
  return `kmp-v4-${sanitized}.db`
}

const dbsByUser = new Map<string, PowerSyncDatabase>()
const initPromises = new Map<string, Promise<void>>()
let activeUserId: string | null = null
let connectChain: Promise<void> = Promise.resolve()

// Firefox and Safari block OPFS in private browsing — `getDirectory()`
// throws SecurityError. Probe once and surface a useful message before
// PowerSync gets to fail with the opaque internal error.
let opfsProbe: Promise<void> | null = null
const assertOpfsAvailable = (): Promise<void> => {
  if (!opfsProbe) {
    opfsProbe = (async () => {
      try {
        await navigator.storage.getDirectory()
      } catch (err) {
        if (err instanceof DOMException && err.name === 'SecurityError') {
          throw new Error(
            'This browser is blocking local storage access (OPFS), which Knowledge Medium needs to keep your data on this device. ' +
            'This usually means you\'re in private/incognito browsing on Firefox or Safari, where OPFS is disabled. ' +
            'Try a regular (non-private) window, or use Chrome — Chrome incognito allows OPFS.',
            {cause: err},
          )
        }
        throw err
      }
    })()
  }
  return opfsProbe
}

// OPFSCoopSyncVFS uses OPFS sync access handles (much faster than
// IndexedDB) and requires a dedicated worker. Single-tab today;
// CoopSync still works correctly if a second tab opens later. We pass
// an explicit `WASQLiteOpenFactory` instead of plain settings because
// the `vfs` option lives on the factory's option type, not on the
// generic `SQLOpenOptions` accepted by `database: {…}`.
const buildPowerSyncDb = (userId: string) => new PowerSyncDatabase({
  schema: appSchema,
  database: new WASQLiteOpenFactory({
    dbFilename: dbFilenameForUser(userId),
    vfs: WASQLiteVFS.OPFSCoopSyncVFS,
  }),
  flags: {
    enableMultiTabs: false,
    useWebWorker: true,
  },
})

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
  await assertOpfsAvailable()
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
  await powerSyncDb.execute(CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL)
  await powerSyncDb.execute(CREATE_BLOCKS_WORKSPACE_TYPE_INDEX_SQL)

  // ── workspaces + workspace_members ──
  await powerSyncDb.execute(CREATE_WORKSPACES_TABLE_SQL)
  await powerSyncDb.execute(CREATE_WORKSPACE_MEMBERS_TABLE_SQL)
  await powerSyncDb.execute(CREATE_WORKSPACE_MEMBERS_INDEX_SQL)

  // ── tx_context, row_events, command_events, block_aliases,
  // block_references + 13 triggers ── (5 audit/upload, 2 workspace-
  // invariant, 3 alias-index, 3 reference-index.) Statements include
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
  await backfillBlockReferencesIfEmpty(backfillDb)
}
