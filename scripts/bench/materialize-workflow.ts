/** Optional Repo-level arrival + one-time reconcile-rescan benchmark.
 *
 * This measures the production Repo/observer path around the same synthetic
 * wire fixture as the lower-level materializer benchmark. It excludes app
 * startup, React, device storage, and network sync. */

import type { PowerSyncDb } from '@/data/internals/commitPipeline.js'
import { RECONCILE_RESCAN_MARKER_PREFIX } from '@/data/internals/clientSchema.js'
import { createTestRepo } from '@/data/test/createTestRepo.js'
import { InMemoryWorkspaceKeyStore } from '@/sync/keys/keyStore.js'
import { setModePin } from '@/sync/keys/modePin.js'
import { createSyncResolver } from '@/sync/keys/resolver.js'
import { createMaterializeMetrics, instrumentMaterializeDb, stageMaterializeRows, validateMaterializeDb, type MaterializeMetrics, type MaterializeWireRows } from './materialize-benchmark-core.js'
import type { MaterializeFixture } from './materialize-fixture.js'

const USER = 'bench-materialize-user'
const cloneMetrics = (metrics: MaterializeMetrics) => ({
  calls: Object.fromEntries(Object.entries(metrics.calls).map(([name, value]) => [name, {...value}])),
  sql: new Map([...metrics.sql].map(([sql, value]) => [sql, {...value}])),
  txCount: metrics.txCount,
  txElapsedMs: metrics.txElapsedMs,
  keyCalls: metrics.keyCalls,
  keyElapsedMs: metrics.keyElapsedMs,
})

const metricDelta = (after: ReturnType<typeof cloneMetrics>, before: ReturnType<typeof cloneMetrics>) => {
  const sql = new Map<string, {count: number; elapsedMs: number}>()
  for (const [statement, value] of after.sql) {
    const old = before.sql.get(statement) ?? {count: 0, elapsedMs: 0}
    sql.set(statement, {count: value.count - old.count, elapsedMs: value.elapsedMs - old.elapsedMs})
  }
  const calls = Object.fromEntries([...new Set([...Object.keys(after.calls), ...Object.keys(before.calls)])]
    .map(name => {
      const a = after.calls[name] ?? {count: 0, elapsedMs: 0}
      const b = before.calls[name] ?? {count: 0, elapsedMs: 0}
      return [name, {count: a.count - b.count, elapsedMs: a.elapsedMs - b.elapsedMs}]
    }))
  return {
    calls, sql,
    txCount: after.txCount - before.txCount,
    txElapsedMs: after.txElapsedMs - before.txElapsedMs,
    keyCalls: after.keyCalls - before.keyCalls,
    keyElapsedMs: after.keyElapsedMs - before.keyElapsedMs,
  }
}

const totalSqlCalls = (snapshot: ReturnType<typeof cloneMetrics>) =>
  Object.values(snapshot.calls).reduce((sum, call) => sum + call.count, 0)

const scanCounts = (snapshot: ReturnType<typeof cloneMetrics>) => {
  const statements = [...snapshot.sql.entries()]
  return {
    fullScans: statements.reduce((sum, [sql, value]) =>
      sum + (/FROM blocks_synced\b/i.test(sql) && /workspace_id\s*=\s*\?/i.test(sql) ? value.count : 0), 0),
    derivationSqlCalls: statements.reduce((sum, [sql, value]) =>
      sum + (/block_aliases/i.test(sql) || /UPDATE blocks SET reference_target_id/i.test(sql) ? value.count : 0), 0),
    totalSqlCalls: totalSqlCalls(snapshot),
    statements: statements.map(([sql, value]) => ({sql, ...value})).filter(value => value.count !== 0),
  }
}

/** The real deferred scheduler fires via Node's setTimeout(0). Resolve on the
 *  causal marker read, then use Repo's pending-job drain barrier. */
const markerReadFence = (db: PowerSyncDb) => {
  let resolve!: () => void
  const observed = new Promise<void>(done => { resolve = done })
  let reached = false
  const instrumentedDb: PowerSyncDb = {
    ...db,
    onChange: db.onChange?.bind(db),
    getOptional: async <T,>(sql: string, params?: unknown[]) => {
      if (!reached && sql.includes('client_schema_state')
        && params?.some(value => typeof value === 'string' && value.startsWith(RECONCILE_RESCAN_MARKER_PREFIX))) {
        reached = true
        resolve()
      }
      return db.getOptional<T>(sql, params)
    },
  }
  return {db: instrumentedDb, observed}
}

/** Node has no browser localStorage; the resolver's normal mode-pin API uses
 *  this tiny in-memory storage shim for the disposable benchmark process. */
const withLocalStorage = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {localStorage}})
  Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: localStorage})
  try { return await fn() }
  finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

export const runMaterializeWorkflowBench = async (
  db: PowerSyncDb,
  resetDatabase: () => Promise<void>,
  fixture: MaterializeFixture,
  rows: MaterializeWireRows,
  key: CryptoKey,
  reps: number,
) => withLocalStorage(async () => {
  const keyStore = new InMemoryWorkspaceKeyStore()
  await keyStore.put(USER, fixture.blocks[0].workspaceId, {wk: key, contentKeyHmac: key})
  setModePin(USER, fixture.blocks[0].workspaceId, 'e2ee')
  const resolver = createSyncResolver(() => USER, keyStore, async () => 'e2ee')
  let keyCalls = 0
  let keyElapsedMs = 0
  const keyStoreGet = keyStore.get.bind(keyStore)
  keyStore.get = async (...args) => {
    const started = performance.now()
    keyCalls++
    try { return await keyStoreGet(...args) }
    finally { keyElapsedMs += performance.now() - started }
  }
  const samples = []

  for (let sample = -1; sample < reps; sample++) {
    await resetDatabase()
    const rawMetrics = createMaterializeMetrics()
    const measuredDb = instrumentMaterializeDb(db, rawMetrics)
    const fence = markerReadFence(measuredDb)
    const env = await createTestRepo({
      db: fence.db,
      user: {id: USER},
      startSyncObserver: false,
      syncObserverDeps: {
        getMaterializability: resolver.getMaterializability,
        getCek: resolver.getCek,
      },
    })
    try {
      // Stage before starting the observer, so arrival-trigger delivery does
      // not overlap the explicit drain whose cost this case measures.
      await stageMaterializeRows(measuredDb, fixture, rows)
      await measuredDb.execute('DELETE FROM blocks_synced_changes')
      env.repo.startSyncObserver()

      const beforeDrain = cloneMetrics(rawMetrics)
      const beforeDrainKeys = keyCalls
      const beforeDrainKeyMs = keyElapsedMs
      const invalidationsBefore = env.repo.metrics().handleStore.invalidations ?? 0
      const drainStarted = performance.now()
      const drain = await env.repo.drainSyncWorkspace(fixture.blocks[0].workspaceId)
      const drainMs = performance.now() - drainStarted
      const drainMetrics = metricDelta(cloneMetrics(rawMetrics), beforeDrain)
      const invalidationsAfterDrain = env.repo.metrics().handleStore.invalidations ?? 0
      const drainKeyCalls = keyCalls - beforeDrainKeys
      const drainKeyMs = keyElapsedMs - beforeDrainKeyMs

      const beforeRescan = cloneMetrics(rawMetrics)
      const beforeRescanKeys = keyCalls
      const beforeRescanKeyMs = keyElapsedMs
      const scheduleStarted = performance.now()
      env.repo.scheduleReconcileRescan(fixture.blocks[0].workspaceId)
      await fence.observed
      await env.repo.awaitReconcileRescans()
      const rescanMs = performance.now() - scheduleStarted
      const rescanMetrics = metricDelta(cloneMetrics(rawMetrics), beforeRescan)
      const rescanKeyCalls = keyCalls - beforeRescanKeys
      const rescanKeyMs = keyElapsedMs - beforeRescanKeyMs
      const validation = await validateMaterializeDb(measuredDb, fixture)

      const result = {
        sample: sample < 0 ? 'warmup' : sample,
        mode: 'e2ee',
        records: fixture.blocks.length,
        drainMs: Math.round(drainMs * 100) / 100,
        drain: {...scanCounts(drainMetrics), keyCalls: drainKeyCalls, keyElapsedMs: Math.round(drainKeyMs * 100) / 100},
        rescanMs: Math.round(rescanMs * 100) / 100,
        rescan: {...scanCounts(rescanMetrics), keyCalls: rescanKeyCalls, keyElapsedMs: Math.round(rescanKeyMs * 100) / 100},
        invalidations: {
          drain: invalidationsAfterDrain - invalidationsBefore,
          rescan: (env.repo.metrics().handleStore.invalidations ?? 0) - invalidationsAfterDrain,
        },
        drainOutcome: drain ? {scope: drain.scope, scanned: drain.scanned, applied: drain.applied} : null,
        validation,
      }
      if (sample >= 0) samples.push(result)
      else console.log(JSON.stringify({workflowSample: result}))
    } finally {
      env.repo.stopSyncObserver()
    }
  }
  return samples
})
