import {PowerSyncDatabase, Schema, WASQLiteVFS} from '@powersync/web'
import * as blockSchema from '@/data/blockSchema'
import {CLIENT_SCHEMA_STATEMENTS} from '@/data/internals/clientSchema'
import {CREATE_WORKSPACES_TABLE_SQL, CREATE_WORKSPACE_MEMBERS_TABLE_SQL} from '@/data/workspaceSchema'
import {applyLocalSchemaContributions, resolveLocalSchemaContributions} from '@/data/localSchema'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {IndexedDbWorkspaceKeyStore} from '@/sync/keys/keyStore'
import {createSyncResolver} from '@/sync/keys/resolver'
import {makeMaterializeFixture, MATERIALIZE_USER_ID, MATERIALIZE_WORKSPACE_ID} from './materialize-fixture'
import type {PowerSyncDb} from '@/data/internals/commitPipeline'

export async function openBrowserTestDb() {
  const schema = new Schema({})
  schema.withRawTables({blocks_synced: blockSchema.BLOCKS_SYNCED_RAW_TABLE})
  const db = new PowerSyncDatabase({
    schema,
    database: {
      dbFilename: 'synthetic-materialize-benchmark.db',
      vfs: WASQLiteVFS.OPFSCoopSyncVFS,
      cacheSizeKb: 262144,
      enableMultiTabs: false,
    },
  })
  console.info('waiting for SQLite')
  await db.waitForReady()
  console.info('initializing synthetic schema')
  for (const sql of [
    blockSchema.CREATE_BLOCKS_TABLE_SQL,
    blockSchema.CREATE_BLOCKS_SYNCED_TABLE_SQL,
    blockSchema.CREATE_BLOCKS_SYNCED_NEEDS_APPLY_INDEX_SQL,
    blockSchema.CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
    blockSchema.CREATE_BLOCKS_PARENT_DELETED_INDEX_SQL,
    blockSchema.CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
    blockSchema.CREATE_BLOCKS_WORKSPACE_NONEMPTY_PROPERTIES_INDEX_SQL,
    blockSchema.CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL,
    blockSchema.CREATE_BLOCKS_REFERENCE_CANDIDATES_INDEX_SQL,
    blockSchema.CREATE_BLOCKS_FIELD_FORM_INDEX_SQL,
    blockSchema.CREATE_BLOCKS_ANY_FIELD_FORM_INDEX_SQL,
    blockSchema.CREATE_BLOCKS_WORKSPACE_RECENT_INDEX_SQL,
    CREATE_WORKSPACES_TABLE_SQL, CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
    ...CLIENT_SCHEMA_STATEMENTS,
  ]) await db.execute(sql)
  await applyLocalSchemaContributions(db, resolveLocalSchemaContributions(staticDataExtensions))
  return db
}

export async function runBrowserMaterializeBench(count = 1000, repetitions = 3) {
  console.info('loading benchmark core')
  const core = await import('./materialize-benchmark-core')
  console.info('creating synthetic keys')
  const store = new IndexedDbWorkspaceKeyStore()
  const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'])
  const contentKeyHmac = await crypto.subtle.generateKey({name: 'HMAC', hash: 'SHA-256'}, false, ['sign'])
  await store.put(MATERIALIZE_USER_ID, MATERIALIZE_WORKSPACE_ID, {wk: key, contentKeyHmac})
  console.info('synthetic keys stored; opening SQLite')
  const resolver = createSyncResolver(() => MATERIALIZE_USER_ID, store, async () => 'e2ee')
  const fixture = makeMaterializeFixture(count)
  const db = await openBrowserTestDb()
  const testDb = db as unknown as PowerSyncDb
  console.info('SQLite ready')
  const samples = []
  try {
    for (const mode of ['none', 'e2ee'] as const) {
      const rows = await core.makeMaterializeWireRows(fixture, mode, key)
      for (const scenario of ['initial', 'echo-repass'] as const) {
        for (let repetition = -1; repetition < repetitions; repetition++) {
          await db.writeTransaction(async tx => {
            await tx.execute('DELETE FROM blocks')
            await tx.execute('DELETE FROM blocks_synced')
            await tx.execute('DELETE FROM blocks_synced_changes')
            await tx.execute('DELETE FROM row_events')
          })
          await core.stageMaterializeRows(testDb, fixture, rows)
          if (scenario === 'echo-repass') {
            await core.runMaterializePass(testDb, fixture, mode, key)
            await core.resetMaterializeNeedsApply(testDb)
          }
          const result = await core.runMaterializePass(testDb, fixture, mode, key, {getCek: resolver.getCek})
          const validation = await core.validateMaterializeDb(testDb, fixture)
          if (repetition >= 0) {
            const sample = {mode, scenario, repetition, ...result, metrics: {...result.metrics, sql: [...result.metrics.sql]}, validation}
            samples.push(sample)
            console.info('sample', JSON.stringify({mode, scenario, repetition, wallMs: result.wallMs, phase1Ms: result.metrics.phase1ElapsedMs, txMs: result.metrics.txElapsedMs, keyCalls: result.metrics.keyCalls, keyMs: result.metrics.keyElapsedMs, sql: result.metrics.calls, validation}))
          }
        }
      }
    }
    return {count, repetitions, userAgent: navigator.userAgent, vfs: 'OPFSCoopSyncVFS', samples}
  } finally {
    await store.delete(MATERIALIZE_USER_ID, MATERIALIZE_WORKSPACE_ID)
    await db.close()
  }
}
