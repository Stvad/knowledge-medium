/**
 * Production bootstrap for the data layer.
 *
 * Per-user SQLite database — the database itself is the user isolation
 * boundary (no shared outbox, no shared cache, no risk of one session's
 * pending uploads being retried under another user's JWT). Sign-out clears
 * the Supabase session but leaves the local DB intact; sign-in as the same
 * user reopens the same DB and unsynced edits resume uploading. Sign-in as
 * a different user opens a fresh DB.
 */

import { BrowserSqliteDb } from '@/data/sqliteDb'
import { hasRemoteSyncConfig } from '@/services/electric.ts'
import {
  CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
} from '@/data/blockSchema'
import {
  CREATE_WORKSPACES_TABLE_SQL,
  CREATE_WORKSPACE_MEMBERS_INDEX_SQL,
  CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
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
import { startUploadLoop, type UploadLoop } from '@/services/upload'
import {
  startShapeSubscriber,
  type ShapeSubscriber,
} from '@/services/sync/shapeSubscriber'

// wa-sqlite's VFS caps pathnames at 64 chars (mxPathname in
// node_modules/@journeyapps/wa-sqlite/src/VFS.js). SQLite derives
// WAL/journal/shm paths from the dbFilename with suffixes up to ~10
// chars, so the base has to stay well under 64 or sqlite3_open_v2
// fails with "Filename too long" and no useful error. 7 (prefix) +
// 40 (user) + 3 (suffix) = 50 — safe headroom.
const MAX_USER_SEGMENT = 40

// v7 = direct wa-sqlite + Electric shape materialization. v6 was managed by
// the previous sync engine; bumping gives the Electric path a fresh local
// file and avoids reusing obsolete internal tables.
export const dbFilenameForUser = (userId: string) => {
  const sanitized = userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_USER_SEGMENT)
  return `kmp-v7-${sanitized}.db`
}

const dbsByUser = new Map<string, BrowserSqliteDb>()
const initPromises = new Map<string, Promise<void>>()
const uploadLoopsByUser = new Map<string, UploadLoop>()
const subscribersByUser = new Map<string, ShapeSubscriber>()
let activeUserId: string | null = null

// Firefox and Safari block OPFS in private browsing — `getDirectory()`
// throws SecurityError. Probe once and surface a useful message before
// wa-sqlite gets to fail with an opaque internal error.
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

export const getRepoDb = (userId: string): BrowserSqliteDb => {
  const existing = dbsByUser.get(userId)
  if (existing) return existing
  throw new Error(`SQLite database for user ${userId} has not been opened yet`)
}

const getOrOpenDb = async (userId: string): Promise<BrowserSqliteDb> => {
  const existing = dbsByUser.get(userId)
  if (existing) return existing
  const db = await BrowserSqliteDb.open(dbFilenameForUser(userId))
  dbsByUser.set(userId, db)
  return db
}

// `useRemoteSync` is the runtime gate (defaults to the build-time
// `hasRemoteSyncConfig`). Callers pass `false` when the user opted into
// local-only mode at login — in that case we still init the local DB +
// triggers but skip Electric subscription/upload.
export const ensureRepoReady = async (
  userId: string,
  useRemoteSync: boolean = hasRemoteSyncConfig,
) => {
  await assertOpfsAvailable()
  const db = await getOrOpenDb(userId)

  let initPromise = initPromises.get(userId)
  if (!initPromise) {
    initPromise = initializeSqliteDb(db)
    initPromises.set(userId, initPromise)
  }
  await initPromise

  if (!useRemoteSync) {
    return
  }

  if (activeUserId && activeUserId !== userId) {
    subscribersByUser.get(activeUserId)?.stop()
    subscribersByUser.delete(activeUserId)
    uploadLoopsByUser.get(activeUserId)?.stop()
    uploadLoopsByUser.delete(activeUserId)
  }

  activeUserId = userId

  if (!uploadLoopsByUser.has(userId)) {
    uploadLoopsByUser.set(userId, startUploadLoop(db))
  }
  if (!subscribersByUser.has(userId)) {
    subscribersByUser.set(userId, startShapeSubscriber(userId, db))
  }
}

const initializeSqliteDb = async (db: BrowserSqliteDb) => {
  // No `PRAGMA journal_mode=WAL`: none of wa-sqlite's OPFS VFSes implement
  // xShmMap (the wal-index shared-memory primitive SQLite needs for native
  // WAL), so SQLite silently keeps rollback journal mode.
  await db.execute('PRAGMA cache_size = -262144')
  await db.execute('PRAGMA temp_store = MEMORY')

  // ── blocks + its indexes ──
  await db.execute(CREATE_BLOCKS_TABLE_SQL)
  await db.execute(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL)
  await db.execute(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)

  // ── workspaces + workspace_members ──
  await db.execute(CREATE_WORKSPACES_TABLE_SQL)
  await db.execute(CREATE_WORKSPACE_MEMBERS_TABLE_SQL)
  await db.execute(CREATE_WORKSPACE_MEMBERS_INDEX_SQL)

  // ── tx_context, row_events, command_events, outbox, block_aliases + core
  // triggers ── Statements include CREATE TABLE IF NOT EXISTS / CREATE INDEX
  // IF NOT EXISTS / CREATE TRIGGER IF NOT EXISTS so re-running is a no-op.
  for (const stmt of CLIENT_SCHEMA_STATEMENTS) {
    await db.execute(stmt)
  }

  const backfillDb = {
    execute: (sql: string) => db.execute(sql),
    getOptional: async <T,>(sql: string) => {
      const row = await db.getOptional<T>(sql)
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
