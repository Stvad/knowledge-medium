import { PowerSyncDatabase } from '@powersync/web'
import { AppSchema } from './powerSyncSchema'
import { runMigrations } from './migrations'

export const powerSyncDb = new PowerSyncDatabase({
  database: {
    dbFilename: 'omniliner1.db'
  },
  schema: AppSchema,
  flags: {
    enableMultiTabs: false  // Start simple, enable later if needed
  }
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
