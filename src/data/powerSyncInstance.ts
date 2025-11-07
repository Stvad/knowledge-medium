import { PowerSyncDatabase, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web'
import { AppSchema } from './powerSyncSchema'
import { runMigrations } from './migrations'

export const powerSyncDb = new PowerSyncDatabase({
  schema: AppSchema,
  database: new WASQLiteOpenFactory({
    dbFilename: 'omniliner2.db',
    vfs: WASQLiteVFS.OPFSCoopSyncVFS, // <- use OPFS
    flags: {enableMultiTabs: typeof SharedWorker !== 'undefined'},
  }),
  flags: {enableMultiTabs: typeof SharedWorker !== 'undefined'},
})

export async function initPowerSync() {
  try {
    // Run migrations to create tables and triggers
    await runMigrations(powerSyncDb)
    console.log('PowerSync initialized in offline-only mode with Raw Tables')
  } catch (error) {
    console.error('Failed to initialize PowerSync:', error)
    throw error
  }
}
