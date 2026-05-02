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
 *     workspace_active, workspace_with_references), workspaces +
 *     workspace_members tables/indexes, then `CLIENT_SCHEMA_STATEMENTS`
 *     (tx_context, row_events, command_events, the 7 v4.27 triggers)
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

import { PowerSyncDatabase, Schema, WASQLiteVFS } from '@powersync/web'
import { createPowerSyncConnector, hasRemoteSyncConfig } from '@/services/powersync.ts'
import {
  BLOCKS_RAW_TABLE,
  CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
  CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL,
} from '@/data/blockSchema'
import {
  CREATE_WORKSPACES_TABLE_SQL,
  CREATE_WORKSPACE_MEMBERS_INDEX_SQL,
  CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
  WORKSPACES_RAW_TABLE,
  WORKSPACE_MEMBERS_RAW_TABLE,
} from '@/data/workspaceSchema'
import { CLIENT_SCHEMA_STATEMENTS, backfillBlockAliasesIfEmpty } from '@/data/internals/clientSchema'

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

// OPFSCoopSyncVFS uses OPFS sync access handles (much faster than
// IndexedDB) and requires a dedicated worker. Single-tab today;
// CoopSync still works correctly if a second tab opens later.
const buildPowerSyncDb = (userId: string) => new PowerSyncDatabase({
  schema: appSchema,
  database: {
    dbFilename: dbFilenameForUser(userId),
    vfs: WASQLiteVFS.OPFSCoopSyncVFS,
  },
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

  // ── blocks + its indexes ──
  await powerSyncDb.execute(CREATE_BLOCKS_TABLE_SQL)
  await powerSyncDb.execute(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL)
  await powerSyncDb.execute(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)
  await powerSyncDb.execute(CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL)

  // ── workspaces + workspace_members ──
  await powerSyncDb.execute(CREATE_WORKSPACES_TABLE_SQL)
  await powerSyncDb.execute(CREATE_WORKSPACE_MEMBERS_TABLE_SQL)
  await powerSyncDb.execute(CREATE_WORKSPACE_MEMBERS_INDEX_SQL)

  // ── tx_context, row_events, command_events, block_aliases + 10
  // triggers ── (5 audit/upload, 2 workspace-invariant, 3 alias-index.)
  // Statements include CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
  // EXISTS / CREATE TRIGGER IF NOT EXISTS so re-running is a no-op
  // against an already-bootstrapped dev database.
  for (const stmt of CLIENT_SCHEMA_STATEMENTS) {
    await powerSyncDb.execute(stmt)
  }

  // One-shot block_aliases backfill for users upgrading from the
  // pre-index schema. Steady-state startups noop on a single LIMIT 1
  // probe.
  await backfillBlockAliasesIfEmpty({
    execute: sql => powerSyncDb.execute(sql),
    getOptional: async <T,>(sql: string) => {
      const row = await powerSyncDb.getOptional<T>(sql)
      return row ?? null
    },
  })
}
