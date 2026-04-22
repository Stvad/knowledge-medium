import { PowerSyncDatabase, Schema } from '@powersync/web'
import { UndoRedoManager } from '@/data/undoRedo.ts'
import { createPowerSyncConnector, hasRemoteSyncConfig } from '@/services/powersync.ts'

const appSchema = new Schema({})

appSchema.withRawTables({
  blocks: {
    put: {
      sql: `
        INSERT OR REPLACE INTO blocks (
          id,
          content,
          properties_json,
          child_ids_json,
          parent_id,
          create_time,
          update_time,
          created_by_user_id,
          updated_by_user_id,
          references_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      params: [
        'Id',
        {Column: 'content'},
        {Column: 'properties_json'},
        {Column: 'child_ids_json'},
        {Column: 'parent_id'},
        {Column: 'create_time'},
        {Column: 'update_time'},
        {Column: 'created_by_user_id'},
        {Column: 'updated_by_user_id'},
        {Column: 'references_json'},
      ],
    },
    delete: {
      sql: 'DELETE FROM blocks WHERE id = ?',
      params: ['Id'],
    },
  },
})

export const powerSyncDb = new PowerSyncDatabase({
  schema: appSchema,
  database: {
    dbFilename: 'knowledge-medium-powersync.db',
  },
  flags: {
    enableMultiTabs: false,
    useWebWorker: false,
  },
})

export const undoRedoManager = new UndoRedoManager()

let initPromise: Promise<void> | null = null
let activeConnectionKey: string | null = null

export const ensurePowerSyncReady = async (connectionKey?: string) => {
  if (!initPromise) {
    initPromise = initializePowerSync()
  }

  await initPromise

  if (!hasRemoteSyncConfig) {
    return
  }

  if (!connectionKey) {
    throw new Error('A connection key is required when remote sync is configured')
  }

  if (activeConnectionKey === connectionKey) {
    return
  }

  if (activeConnectionKey) {
    await powerSyncDb.disconnect()
  }

  await powerSyncDb.connect(createPowerSyncConnector())
  activeConnectionKey = connectionKey
}

const buildBlockSnapshotJsonSql = (rowRef: string) => `
  json_object(
    'id', ${rowRef}.id,
    'content', ${rowRef}.content,
    'properties', json(${rowRef}.properties_json),
    'childIds', json(${rowRef}.child_ids_json),
    'parentId', ${rowRef}.parent_id,
    'createTime', ${rowRef}.create_time,
    'updateTime', ${rowRef}.update_time,
    'createdByUserId', ${rowRef}.created_by_user_id,
    'updatedByUserId', ${rowRef}.updated_by_user_id,
    'references', json(${rowRef}.references_json)
  )
`

const initializePowerSync = async () => {
  await powerSyncDb.init()

  await powerSyncDb.execute(`
    CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      properties_json TEXT NOT NULL DEFAULT '{}',
      child_ids_json TEXT NOT NULL DEFAULT '[]',
      parent_id TEXT,
      create_time INTEGER NOT NULL,
      update_time INTEGER NOT NULL,
      created_by_user_id TEXT NOT NULL,
      updated_by_user_id TEXT NOT NULL,
      references_json TEXT NOT NULL DEFAULT '[]'
    )
  `)

  await powerSyncDb.execute(`
    CREATE INDEX IF NOT EXISTS idx_blocks_parent_id
    ON blocks (parent_id)
  `)

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
        json_object(
          'content', NEW.content,
          'properties_json', NEW.properties_json,
          'child_ids_json', NEW.child_ids_json,
          'parent_id', NEW.parent_id,
          'create_time', NEW.create_time,
          'update_time', NEW.update_time,
          'created_by_user_id', NEW.created_by_user_id,
          'updated_by_user_id', NEW.updated_by_user_id,
          'references_json', NEW.references_json
        )
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
        json_object(
          'content', NEW.content,
          'properties_json', NEW.properties_json,
          'child_ids_json', NEW.child_ids_json,
          'parent_id', NEW.parent_id,
          'create_time', NEW.create_time,
          'update_time', NEW.update_time,
          'created_by_user_id', NEW.created_by_user_id,
          'updated_by_user_id', NEW.updated_by_user_id,
          'references_json', NEW.references_json
        )
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
