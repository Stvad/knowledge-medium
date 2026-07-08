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
  BLOCK_STORAGE_COLUMNS,
  blockToRowParams,
} from '@/data/blockSchema'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  startBlocksSyncedObserver,
  type BlocksSyncedObserver,
} from '../observer.js'
import type { GetMaterializability } from '../materialize.js'
import type { BlockData, CycleDetectedEvent } from '@/data/api'
import type { ChangeNotification } from '@/data/internals/handleStore'
import type { InvalidationRule } from '@/data/invalidation'
import type { GetCek, Materializability } from '@/sync/transform.js'

/** No workspace key — the copy-through (plaintext) `getCek`. */
export const noKey: GetCek = async () => null

/** Constant materializability resolver ('copy' plaintext / 'decrypt' e2ee / 'defer'). */
export const constMat = (m: Materializability): GetMaterializability => () => m

const COLUMN_NAMES = BLOCK_STORAGE_COLUMNS.map(c => c.name)
const INSERT_BLOCK_SQL =
  `INSERT INTO blocks (${COLUMN_NAMES.join(', ')}) ` +
  `VALUES (${COLUMN_NAMES.map(() => '?').join(', ')})`

/** Positional staging-row params with the three content columns replaced by
 *  already-encoded (ciphertext) strings — for e2ee materialization tests. */
export const stagingCiphertextParams = (
  meta: BlockData,
  wire: { content: string; properties_json: string; references_json: string },
): unknown[] => {
  const params = blockToRowParams(meta)
  params[4] = wire.content
  params[5] = wire.properties_json
  params[6] = wire.references_json
  return params
}

export interface StartObserverOpts {
  getMaterializability: GetMaterializability
  getCek?: GetCek
  onCycleDetected?: (e: CycleDetectedEvent) => void
  drainChunkSize?: number
  onError?: (err: unknown) => void
  getInvalidationRules?: () => readonly InvalidationRule[]
  throttleMs?: number
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
      deps: { getMaterializability: opts.getMaterializability, getCek: opts.getCek ?? noKey },
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
      env.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, params ?? blockToRowParams(d)),
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
    pendingRestage: () =>
      env.db.getAll<{ id: string }>('SELECT id FROM pending_restage ORDER BY id'),
    queuePendingUpload: (id: string) =>
      env.db.execute(
        "INSERT INTO ps_crud (tx_id, data) VALUES (1, json_object('op','PATCH','type','blocks','id',?,'data',json_object()))",
        [id],
      ),
  }
}
