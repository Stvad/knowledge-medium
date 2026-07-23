/**
 * Shared `@powersync/node` test harness for the Layout B sync observer.
 *
 * `observer.test.ts`, `materialize.test.ts`, and (cross-module) the connector's
 * `services/powersync.selfHeal.test.ts` all drive the real observer/materializer
 * against a production-schema `@powersync/node` DB. This centralizes the DB
 * lifecycle (one DB per file, reset per test), the row/queue helpers, and the
 * observer starter so they don't drift across files.
 *
 * NOT centralized: each file's `blockData`/`data` builder stays local — the
 * default timestamps/authors diverge and are asserted on (e.g. materialize
 * expects `updated_at` 1700000000000), so one shared default would change those
 * assertions. Also local: file-specific helpers (`racingDb`, `e2eeStaging`).
 */
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import {
  BLOCKS_SYNCED_RAW_TABLE,
  BLOCKS_TABLE_COLUMN_NAMES,
  blockToRowParams,
  blockToSyncedRowParams,
} from '@/data/blockSchema'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  startBlocksSyncedObserver,
  type BlocksSyncedObserver,
} from '../observer.js'
import {
  materializeStagingRows,
  type GetMaterializability,
  type MaterializeDeps,
  type MaterializeOptions,
  type MaterializeOutcome,
} from '../materialize.js'
import type { PowerSyncDb } from '@/data/internals/commitPipeline.js'
import type { BlockData, CycleDetectedEvent } from '@/data/api'
import type { ChangeNotification } from '@/data/internals/handleStore'
import type { InvalidationRule } from '@/data/invalidation'
import type { GetCek, Materializability } from '@/sync/transform.js'

/** No workspace key — the copy-through (plaintext) `getCek`. */
export const noKey: GetCek = async () => null

/** Constant materializability resolver ('copy' plaintext / 'decrypt' e2ee / 'defer'). */
export const constMat = (m: Materializability): GetMaterializability => () => m

const INSERT_BLOCK_SQL =
  `INSERT INTO blocks (${BLOCKS_TABLE_COLUMN_NAMES.join(', ')}) ` +
  `VALUES (${BLOCKS_TABLE_COLUMN_NAMES.map(() => '?').join(', ')})`

/** Positional staging-row params with the three content columns replaced by
 *  already-encoded (ciphertext) strings — for e2ee materialization tests.
 *  Storage-only (13 params, `blockToSyncedRowParams`) — `blocks_synced` never
 *  carries the local-only columns. */
export const stagingCiphertextParams = (
  meta: BlockData,
  wire: { content: string; properties_json: string; references_json: string },
): unknown[] => {
  const params = blockToSyncedRowParams(meta)
  params[4] = wire.content
  params[5] = wire.properties_json
  params[6] = wire.references_json
  return params
}

/**
 * Single-window queue drain — mirrors `drainQueueOnce`'s per-window core
 * (`../observer.ts:186-220`): read the pending `blocks_synced_changes`
 * queue ordered by seq, dedup to latest-op-per-id, run
 * `materializeStagingRows` over the whole window, then
 * `DELETE ... WHERE seq <= maxSeq` to consume it. Returns `null` when the
 * queue was empty (nothing to drain) so callers can distinguish "flushed
 * nothing" from "flushed and materialized nothing" — `materializeStateful`'s
 * `doFlush` has a real empty-queue branch that depends on this.
 *
 * Unlike the real `drainQueueOnce` this does exactly ONE window, never a
 * chunk-bounded loop over a larger backlog — multi-window backlog behavior
 * is `observer.test.ts`'s job. Shared by `twoRepoConvergence.fuzz.test.ts`
 * (which layers `applySyncInvalidation` on top, replicating the observer's
 * `applyOutcome`) and `materializeStateful.fuzz.test.ts` (which layers its
 * differential-model assertions on top and passes through `readChunkSize`).
 */
export const drainStagingWindowOnce = async (
  db: PowerSyncDb,
  deps: MaterializeDeps,
  opts: MaterializeOptions = {},
): Promise<MaterializeOutcome | null> => {
  const rows = await db.getAll<{ seq: number; id: string; op: 'upsert' | 'delete' }>(
    'SELECT seq, id, op FROM blocks_synced_changes ORDER BY seq',
  )
  if (rows.length === 0) return null
  const maxSeq = rows.at(-1)!.seq
  const opById = new Map<string, 'upsert' | 'delete'>()
  for (const row of rows) opById.set(row.id, row.op)
  const upserted: string[] = []
  const removed: string[] = []
  for (const [id, op] of opById) (op === 'upsert' ? upserted : removed).push(id)

  const outcome = await materializeStagingRows(db, { upserted, removed }, deps, opts)
  await db.execute('DELETE FROM blocks_synced_changes WHERE seq <= ?', [maxSeq])
  return outcome
}

export interface StartObserverOpts {
  getMaterializability: GetMaterializability
  getCek?: GetCek
  onCycleDetected?: (e: CycleDetectedEvent) => void
  drainChunkSize?: number
  onError?: (err: unknown) => void
  getInvalidationRules?: () => readonly InvalidationRule[]
  throttleMs?: number
  /** Derive-at-arrival lookups (PR #288 slice A). Omitted by default so
   *  storage-focused tests skip derivation, mirroring the prod-optional dep. */
  referenceTargetLookups?: MaterializeDeps['referenceTargetLookups']
  /** §9 alias-repair hook passthrough (deferred executor lives on Repo). */
  onAliasTargetsAdded?: MaterializeDeps['onAliasTargetsAdded']
}

export interface StartedObserver {
  observer: BlocksSyncedObserver
  cache: BlockCache
  notifications: ChangeNotification[]
}

/**
 * Register the shared-DB lifecycle for a test file and return `env` (whose `.db`
 * is the live connection, reset before each test), the row/queue helpers, and an
 * observer `start`. Call once at file top level.
 *
 * Observers created via `start` are disposed in an `afterEach`; a file that never
 * starts one (e.g. `materialize.test.ts`) just leaves that list empty.
 */
export const setupObserverTestDb = () => {
  let shared: TestDb
  const env = { db: null as unknown as TestDb['db'] }
  const observers: BlocksSyncedObserver[] = []

  beforeAll(async () => {
    shared = await createTestDb()
    env.db = shared.db
  })
  afterAll(async () => { await shared.cleanup() })
  beforeEach(async () => { await resetTestDb(shared.db) })
  afterEach(() => { for (const o of observers) o.dispose() })

  const start = (opts: StartObserverOpts): StartedObserver => {
    const cache = new BlockCache()
    const notifications: ChangeNotification[] = []
    const observer = startBlocksSyncedObserver({
      db: env.db,
      cache,
      handleStore: { invalidate: n => notifications.push(n) },
      deps: {
        getMaterializability: opts.getMaterializability,
        getCek: opts.getCek ?? noKey,
        referenceTargetLookups: opts.referenceTargetLookups,
        onAliasTargetsAdded: opts.onAliasTargetsAdded,
      },
      onCycleDetected: opts.onCycleDetected,
      throttleMs: opts.throttleMs ?? 5,
      drainChunkSize: opts.drainChunkSize,
      onError: opts.onError,
      getInvalidationRules: opts.getInvalidationRules,
    })
    observers.push(observer)
    return { observer, cache, notifications }
  }

  return {
    env,
    observers,
    start,
    seedLocalBlock: (d: BlockData) => env.db.execute(INSERT_BLOCK_SQL, blockToRowParams(d)),
    stageRow: (d: BlockData, params?: unknown[]) =>
      env.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, params ?? blockToSyncedRowParams(d)),
    deleteStagingRow: (id: string) =>
      env.db.execute(BLOCKS_SYNCED_RAW_TABLE.delete.sql, [id]),
    blocks: () =>
      env.db.getAll<{ id: string; content: string }>('SELECT id, content FROM blocks ORDER BY id'),
    allBlocks: () =>
      env.db.getAll<{ id: string; content: string; properties_json: string; updated_at: number }>(
        'SELECT id, content, properties_json, updated_at FROM blocks ORDER BY id',
      ),
    queueLen: async () => (await env.db.getAll('SELECT seq FROM blocks_synced_changes')).length,
    crudCount: async () => (await env.db.getAll('SELECT id FROM ps_crud')).length,
    queuePendingUpload: (id: string) =>
      env.db.execute(
        "INSERT INTO ps_crud (tx_id, data) VALUES (1, json_object('op','PATCH','type','blocks','id',?,'data',json_object()))",
        [id],
      ),
  }
}
