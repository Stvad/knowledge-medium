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
}
