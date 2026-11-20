import {PowerSyncDatabase, Schema, WASQLiteVFS} from '@powersync/web'
import * as blockSchema from '@/data/blockSchema'
import {CLIENT_SCHEMA_STATEMENTS} from '@/data/internals/clientSchema'
import {CREATE_WORKSPACES_TABLE_SQL, CREATE_WORKSPACE_MEMBERS_TABLE_SQL} from '@/data/workspaceSchema'
import {applyLocalSchemaContributions, resolveLocalSchemaContributions} from '@/data/localSchema'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {IndexedDbWorkspaceKeyStore} from '@/sync/keys/keyStore'
import {createSyncResolver} from '@/sync/keys/resolver'
import {makeMaterializeFixture, MATERIALIZE_USER_ID, MATERIALIZE_WORKSPACE_ID} from './materialize-fixture'
import {runVariantSamples, validateVariantOptions, variantInfoOf, type VariantOptions} from './materialize-variants'
import type {MaterializeMode} from './materialize-benchmark-core'
import type {PowerSyncDb} from '@/data/internals/commitPipeline'

export type BrowserVfs = 'coop-sync' | 'write-ahead'

/** Mirrors production: the write-ahead VFS opens one writer plus ADDITIONAL_READERS (1) reader
 *  connections and the total page cache is split across them (src/data/repoProvider.ts). */
const READERS_WRITE_AHEAD = 1

export async function openBrowserTestDb(vfs: BrowserVfs = 'coop-sync', totalCacheKb = 262144) {
  const writeAhead = vfs === 'write-ahead'
  const connections = writeAhead ? 1 + READERS_WRITE_AHEAD : 1
  const schema = new Schema({})
  schema.withRawTables({blocks_synced: blockSchema.BLOCKS_SYNCED_RAW_TABLE})
  const db = new PowerSyncDatabase({
    schema,
    database: {
      dbFilename: 'synthetic-materialize-benchmark.db',
      vfs: writeAhead ? WASQLiteVFS.OPFSWriteAheadVFS : WASQLiteVFS.OPFSCoopSyncVFS,
      ...(writeAhead ? {additionalReaders: READERS_WRITE_AHEAD} : {}),
      cacheSizeKb: Math.floor(totalCacheKb / connections),
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
    blockSchema.CREATE_BLOCKS_BEING_EDITED_INDEX_SQL,
    CREATE_WORKSPACES_TABLE_SQL, CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
    ...CLIENT_SCHEMA_STATEMENTS,
  ]) await db.execute(sql)
  await applyLocalSchemaContributions(db, resolveLocalSchemaContributions(staticDataExtensions))
  return db
}

export type BrowserBenchOptions = Partial<VariantOptions> & {records?: number; reps?: number; vfs?: BrowserVfs}

export async function runBrowserMaterializeBench(
  countOrOptions: number | BrowserBenchOptions = 1000, repetitions = 3,
) {
  const o: BrowserBenchOptions = typeof countOrOptions === 'number'
    ? {records: countOrOptions, reps: repetitions} : countOrOptions
  const count = o.records ?? 1000
  const reps = o.reps ?? 3
  const vfs = o.vfs ?? 'coop-sync'
  const options: VariantOptions = {
    window: o.window ?? 1000,
    modes: o.modes ?? ['none', 'e2ee'],
    scenarios: o.scenarios ?? ['initial', 'echo-repass'],
    dropTriggers: o.dropTriggers ?? [], dropIndexes: o.dropIndexes ?? false,
    rebuildDerived: o.rebuildDerived ?? false, randomIds: o.randomIds ?? false, cacheKb: o.cacheKb,
  }
  validateVariantOptions({...options, records: count, reps})
  console.info('loading benchmark core')
  const core = await import('./materialize-benchmark-core')
  console.info('creating synthetic keys')
  const store = new IndexedDbWorkspaceKeyStore()
  const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'])
  const contentKeyHmac = await crypto.subtle.generateKey({name: 'HMAC', hash: 'SHA-256'}, false, ['sign'])
  await store.put(MATERIALIZE_USER_ID, MATERIALIZE_WORKSPACE_ID, {wk: key, contentKeyHmac})
  console.info('synthetic keys stored; opening SQLite')
  const resolver = createSyncResolver(() => MATERIALIZE_USER_ID, store, async () => 'e2ee')
  const fixture = makeMaterializeFixture(count, {randomIds: options.randomIds})
  const db = await openBrowserTestDb(vfs, options.cacheKb)
  const testDb = db as unknown as PowerSyncDb
  console.info('SQLite ready')
  const samples: Record<string, unknown>[] = []
  try {
    const prepared = new Map<MaterializeMode, Awaited<ReturnType<typeof core.makeMaterializeWireRows>>>()
    for (const mode of options.modes) prepared.set(mode, await core.makeMaterializeWireRows(fixture, mode, key))
    await runVariantSamples({
      db: testDb, fixture, key, prepared, options, getCek: resolver.getCek,
      resetDb: () => db.writeTransaction(async tx => {
        await tx.execute('DELETE FROM blocks')
        await tx.execute('DELETE FROM blocks_synced')
        await tx.execute('DELETE FROM blocks_synced_changes')
        await tx.execute('DELETE FROM row_events')
      }),
      onSample: ({mode, scenario, sample, result, validation, extra}) => {
        if (sample < 0) return
        const record = {mode, scenario, repetition: sample, ...result, metrics: {...result.metrics, sql: [...result.metrics.sql]}, validation, extra}
        samples.push(record)
        console.info('sample', JSON.stringify({mode, scenario, repetition: sample, wallMs: result.wallMs, phase1Ms: result.metrics.phase1ElapsedMs, txMs: result.metrics.txElapsedMs, keyCalls: result.metrics.keyCalls, keyMs: result.metrics.keyElapsedMs, sql: result.metrics.calls, validation, extra}))
      },
    }, reps)
    return {
      count, repetitions: reps, userAgent: navigator.userAgent,
      vfs: vfs === 'write-ahead' ? 'OPFSWriteAheadVFS' : 'OPFSCoopSyncVFS',
      window: options.window, variant: variantInfoOf(options), samples,
    }
  } finally {
    await store.delete(MATERIALIZE_USER_ID, MATERIALIZE_WORKSPACE_ID)
    await db.close()
  }
}
