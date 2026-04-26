import { PowerSyncDatabase, Schema } from '@powersync/web'
import { UndoRedoManager } from '@/data/undoRedo.ts'
import { createPowerSyncConnector, hasRemoteSyncConfig } from '@/services/powersync.ts'
import {
  BLOCKS_RAW_TABLE,
  CREATE_BLOCKS_PARENT_ID_INDEX_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  buildBlockCrudJsonSql,
  buildBlockSnapshotJsonSql,
} from '@/data/blockSchema'
import {
  CREATE_WORKSPACES_TABLE_SQL,
  CREATE_WORKSPACE_MEMBERS_INDEX_SQL,
  CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
  WORKSPACES_RAW_TABLE,
  WORKSPACE_MEMBERS_RAW_TABLE,
} from '@/data/workspaceSchema'

// Each Supabase user gets their own IndexedDB-backed SQLite database. The
// database itself is the per-user isolation boundary: there's no shared
// CRUD queue, no shared cache, no chance for one session's pending uploads
// to be retried under another session's JWT (which is what would happen if
// we kept a single global db across user changes — RLS would reject every
// upload from the wrong user forever).
//
// Sign-out is therefore inert with respect to local data: it just clears
// the Supabase session. A later sign-in as the same user reopens the same
// database and unsynced edits resume uploading. A sign-in as a different
// user opens a fresh database; the previous user's data stays put on
// disk until they sign back in.

const appSchema = new Schema({})
appSchema.withRawTables({
  blocks: BLOCKS_RAW_TABLE,
  workspaces: WORKSPACES_RAW_TABLE,
  workspace_members: WORKSPACE_MEMBERS_RAW_TABLE,
})

// wa-sqlite's VFS caps pathnames at 64 chars (mxPathname in
// node_modules/@journeyapps/wa-sqlite/src/VFS.js). SQLite derives WAL/journal/
// shm paths from the dbFilename with suffixes up to ~10 chars, so the base
// has to stay well under 64 or sqlite3_open_v2 fails with no useful error
// message ("Filename too long"). 7 (prefix) + 40 (user) + 3 (suffix) = 50.
const MAX_USER_SEGMENT = 40

const dbFilenameForUser = (userId: string) => {
  const sanitized = userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_USER_SEGMENT)
  return `kmp-v2-${sanitized}.db`
}

const dbsByUser = new Map<string, PowerSyncDatabase>()
const initPromises = new Map<string, Promise<void>>()
let activeUserId: string | null = null
let connectChain: Promise<void> = Promise.resolve()

export const undoRedoManager = new UndoRedoManager()

const buildPowerSyncDb = (userId: string) => new PowerSyncDatabase({
  schema: appSchema,
  database: {
    dbFilename: dbFilenameForUser(userId),
  },
  flags: {
    enableMultiTabs: false,
    useWebWorker: false,
  },
})

export const getPowerSyncDb = (userId: string): PowerSyncDatabase => {
  const existing = dbsByUser.get(userId)
  if (existing) return existing
  const db = buildPowerSyncDb(userId)
  dbsByUser.set(userId, db)
  return db
}

export const ensurePowerSyncReady = async (userId: string) => {
  const db = getPowerSyncDb(userId)

  let initPromise = initPromises.get(userId)
  if (!initPromise) {
    initPromise = initializePowerSyncDb(db)
    initPromises.set(userId, initPromise)
  }
  await initPromise

  if (!hasRemoteSyncConfig) {
    return
  }

  if (activeUserId === userId) {
    return
  }

  const previousUserId = activeUserId
  activeUserId = userId

  // Run disconnect+connect serially so we don't race two connect attempts.
  // Don't await the chain here — connect can take a while and we want render
  // to proceed against the local cache.
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

  await powerSyncDb.execute(CREATE_BLOCKS_TABLE_SQL)
  await powerSyncDb.execute(CREATE_BLOCKS_PARENT_ID_INDEX_SQL)
  await powerSyncDb.execute(`
    CREATE INDEX IF NOT EXISTS idx_blocks_workspace_id
    ON blocks (workspace_id)
  `)

  await powerSyncDb.execute(CREATE_WORKSPACES_TABLE_SQL)
  await powerSyncDb.execute(CREATE_WORKSPACE_MEMBERS_TABLE_SQL)
  await powerSyncDb.execute(CREATE_WORKSPACE_MEMBERS_INDEX_SQL)

  await powerSyncDb.execute(`
    CREATE TABLE IF NOT EXISTS block_event_context (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tx_id TEXT NOT NULL,
      source TEXT NOT NULL,
      actor_user_id TEXT
    )
  `)

  await powerSyncDb.execute(`
    DELETE FROM block_event_context
    WHERE id = 1
  `)

  await powerSyncDb.execute(`
    CREATE TABLE IF NOT EXISTS block_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      tx_id TEXT NOT NULL,
      event_time INTEGER NOT NULL,
      source TEXT NOT NULL,
      actor_user_id TEXT,
      block_id TEXT NOT NULL,
      op TEXT NOT NULL,
      event_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT
    )
  `)

  await powerSyncDb.execute(`
    CREATE INDEX IF NOT EXISTS idx_block_events_block_id_seq
    ON block_events (block_id, seq DESC)
  `)

  await powerSyncDb.execute(`
    CREATE INDEX IF NOT EXISTS idx_block_events_event_time_seq
    ON block_events (event_time, seq DESC)
  `)

  await powerSyncDb.execute(`
    CREATE INDEX IF NOT EXISTS idx_block_events_tx_id_seq
    ON block_events (tx_id, seq ASC)
  `)

  await powerSyncDb.execute(`
    CREATE TRIGGER IF NOT EXISTS blocks_insert_to_powersync_crud
    AFTER INSERT ON blocks
    FOR EACH ROW
    BEGIN
      INSERT INTO powersync_crud (op, id, type, data)
      VALUES (
        'PUT',
        NEW.id,
        'blocks',
        ${buildBlockCrudJsonSql('NEW')}
      );
    END
  `)

  await powerSyncDb.execute(`
    CREATE TRIGGER IF NOT EXISTS blocks_update_to_powersync_crud
    AFTER UPDATE ON blocks
    FOR EACH ROW
    BEGIN
      SELECT CASE
        WHEN OLD.id != NEW.id
        THEN RAISE(FAIL, 'Cannot update block id')
      END;

      INSERT INTO powersync_crud (op, id, type, data)
      VALUES (
        'PATCH',
        NEW.id,
        'blocks',
        ${buildBlockCrudJsonSql('NEW')}
      );
    END
  `)

  await powerSyncDb.execute(`
    CREATE TRIGGER IF NOT EXISTS blocks_delete_to_powersync_crud
    AFTER DELETE ON blocks
    FOR EACH ROW
    BEGIN
      INSERT INTO powersync_crud (op, id, type)
      VALUES ('DELETE', OLD.id, 'blocks');
    END
  `)

  await powerSyncDb.execute(`
    CREATE TRIGGER IF NOT EXISTS blocks_insert_to_block_events
    AFTER INSERT ON blocks
    FOR EACH ROW
    BEGIN
      INSERT INTO block_events (
        event_id,
        tx_id,
        event_time,
        source,
        actor_user_id,
        block_id,
        op,
        event_name,
        args_json,
        before_json,
        after_json
      )
      VALUES (
        lower(hex(randomblob(16))),
        COALESCE((SELECT tx_id FROM block_event_context WHERE id = 1), 'sync:' || lower(hex(randomblob(8)))),
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
        COALESCE((SELECT source FROM block_event_context WHERE id = 1), 'sync'),
        COALESCE((SELECT actor_user_id FROM block_event_context WHERE id = 1), NEW.updated_by_user_id),
        NEW.id,
        'INSERT',
        'v1.BlockCreated',
        ${buildBlockSnapshotJsonSql('NEW')},
        NULL,
        ${buildBlockSnapshotJsonSql('NEW')}
      );
    END
  `)

  await powerSyncDb.execute(`
    CREATE TRIGGER IF NOT EXISTS blocks_update_to_block_events
    AFTER UPDATE ON blocks
    FOR EACH ROW
    BEGIN
      INSERT INTO block_events (
        event_id,
        tx_id,
        event_time,
        source,
        actor_user_id,
        block_id,
        op,
        event_name,
        args_json,
        before_json,
        after_json
      )
      VALUES (
        lower(hex(randomblob(16))),
        COALESCE((SELECT tx_id FROM block_event_context WHERE id = 1), 'sync:' || lower(hex(randomblob(8)))),
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
        COALESCE((SELECT source FROM block_event_context WHERE id = 1), 'sync'),
        COALESCE((SELECT actor_user_id FROM block_event_context WHERE id = 1), NEW.updated_by_user_id),
        NEW.id,
        'UPDATE',
        'v1.BlockUpdated',
        ${buildBlockSnapshotJsonSql('NEW')},
        ${buildBlockSnapshotJsonSql('OLD')},
        ${buildBlockSnapshotJsonSql('NEW')}
      );
    END
  `)

  await powerSyncDb.execute(`
    CREATE TRIGGER IF NOT EXISTS blocks_delete_to_block_events
    AFTER DELETE ON blocks
    FOR EACH ROW
    BEGIN
      INSERT INTO block_events (
        event_id,
        tx_id,
        event_time,
        source,
        actor_user_id,
        block_id,
        op,
        event_name,
        args_json,
        before_json,
        after_json
      )
      VALUES (
        lower(hex(randomblob(16))),
        COALESCE((SELECT tx_id FROM block_event_context WHERE id = 1), 'sync:' || lower(hex(randomblob(8)))),
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
        COALESCE((SELECT source FROM block_event_context WHERE id = 1), 'sync'),
        COALESCE((SELECT actor_user_id FROM block_event_context WHERE id = 1), OLD.updated_by_user_id),
        OLD.id,
        'DELETE',
        'v1.BlockDeleted',
        json_object('id', OLD.id),
        ${buildBlockSnapshotJsonSql('OLD')},
        NULL
      );
    END
  `)

  await powerSyncDb.execute(`
    INSERT INTO block_events (
      event_id,
      tx_id,
      event_time,
      source,
      actor_user_id,
      block_id,
      op,
      event_name,
      args_json,
      before_json,
      after_json
    )
    SELECT
      lower(hex(randomblob(16))) AS event_id,
      'bootstrap:' || lower(hex(randomblob(8))) AS tx_id,
      blocks.update_time AS event_time,
      'system' AS source,
      blocks.updated_by_user_id AS actor_user_id,
      blocks.id AS block_id,
      'SNAPSHOT' AS op,
      'v1.BlockSnapshotImported' AS event_name,
      ${buildBlockSnapshotJsonSql('blocks')} AS args_json,
      NULL AS before_json,
      ${buildBlockSnapshotJsonSql('blocks')} AS after_json
    FROM blocks
    WHERE NOT EXISTS (
      SELECT 1 FROM block_events LIMIT 1
    )
  `)
}
