import { PowerSyncDatabase, Schema } from '@powersync/web'
import { UndoRedoManager } from '@/data/undoRedo.ts'

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

export const ensurePowerSyncReady = async () => {
  if (!initPromise) {
    initPromise = initializePowerSync()
  }

  return initPromise
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
}
