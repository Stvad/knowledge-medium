import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams, type BlockRow } from '@/data/blockSchema.js'
import { materializeStagingRows, type MaterializeDeps } from '@/data/internals/syncObserver/materialize.js'
import type { PowerSyncDb } from '@/data/internals/commitPipeline.js'
import { encodeForWire, type GetCek } from '@/sync/transform.js'
import type { MaterializeFixture } from './materialize-fixture.js'

export const DEFAULT_MATERIALIZE_WINDOW_SIZE = 1000
const ALIAS_SQL = 'SELECT block_id AS id FROM block_aliases WHERE workspace_id = ? AND alias = ? LIMIT 1'

export interface QueryMetric { count: number; elapsedMs: number }
export interface MaterializeMetrics {
  calls: Record<string, QueryMetric>
  sql: Map<string, QueryMetric>
  txCount: number
  txElapsedMs: number
  phase1ElapsedMs: number
  keyCalls: number
  keyElapsedMs: number
}
export interface MaterializeValidation {
  materializedRows: number
  needsApplyRemaining: number
  uploads: number
  derivedReferenceTargets: number
  derivedFieldForms: number
}
export interface MaterializePassResult {
  metrics: MaterializeMetrics
  wallMs: number
  applied: number
  skippedStale: number
}
export type MaterializeMode = 'none' | 'e2ee'
export type MaterializeWireRows = Awaited<ReturnType<typeof makeMaterializeWireRows>>

export const createMaterializeMetrics = (): MaterializeMetrics => ({
  calls: {}, sql: new Map(), txCount: 0, txElapsedMs: 0, phase1ElapsedMs: 0,
  keyCalls: 0, keyElapsedMs: 0,
})

const sqlKey = (sql: string) => sql.replace(/\s+/g, ' ').trim().replace(
  /IN\s*\(([^)]*)\)/gi,
  (_match, binds: string) => {
    const count = (binds.match(/\?/g) ?? []).length
    return count > 20 ? `IN (<${count} binds>)` : `IN (${binds})`
  },
)

const instrument = (
  raw: PowerSyncDb, metrics: MaterializeMetrics, onFirstTransaction?: () => void,
): PowerSyncDb => {
  let sawTransaction = false
  const wrapReader = <T extends PowerSyncDb>(db: T): T => {
    const method = <K extends 'execute' | 'getAll' | 'getOptional' | 'get'>(name: K) =>
      async (sql: string, params?: unknown[]) => {
        const started = performance.now()
        try {
          return await (db[name] as (sql: string, params?: unknown[]) => Promise<unknown>)(sql, params)
        } finally {
          const elapsedMs = performance.now() - started
          const call = metrics.calls[name] ??= {count: 0, elapsedMs: 0}
          call.count++
          call.elapsedMs += elapsedMs
          const key = sqlKey(sql)
          const query = metrics.sql.get(key) ?? {count: 0, elapsedMs: 0}
          query.count++
          query.elapsedMs += elapsedMs
          metrics.sql.set(key, query)
        }
      }
    return {
      ...db,
      execute: method('execute') as T['execute'],
      getAll: method('getAll') as T['getAll'],
      getOptional: method('getOptional') as T['getOptional'],
      get: method('get') as T['get'],
      writeTransaction: (fn => {
        if (!sawTransaction) {
          sawTransaction = true
          onFirstTransaction?.()
        }
        metrics.txCount++
        const started = performance.now()
        return db.writeTransaction(async tx => fn(wrapReader(tx as unknown as T)))
          .finally(() => { metrics.txElapsedMs += performance.now() - started })
      }) as T['writeTransaction'],
    } as T
  }
  return wrapReader(raw)
}

/** Encode a deterministic fixture as rows exactly as they cross the sync wire. */
export const makeMaterializeWireRows = async (
  fixture: MaterializeFixture, mode: MaterializeMode, key: CryptoKey,
) => {
  const rows = []
  for (const block of fixture.blocks) {
    const row = {
      id: block.id, workspace_id: block.workspaceId, parent_id: block.parentId,
      order_key: block.orderKey, content: block.content,
      properties_json: JSON.stringify(block.properties), references_json: JSON.stringify(block.references),
      created_at: block.createdAt, updated_at: block.updatedAt, user_updated_at: block.userUpdatedAt,
      created_by: block.createdBy, updated_by: block.updatedBy, deleted: 0 as const,
    }
    rows.push(await encodeForWire(row, mode, async () => key))
  }
  return rows
}

/** Insert the already-encoded fixture via the production raw staging-table SQL. */
export const stageMaterializeRows = async (
  db: PowerSyncDb, fixture: MaterializeFixture, rows: MaterializeWireRows,
) => {
  await db.writeTransaction(async tx => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const params = blockToSyncedRowParams(fixture.blocks[i])
      params[4] = row.content
      params[5] = row.properties_json
      params[6] = row.references_json
      await tx.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, params)
    }
  })
}

export const resetMaterializeNeedsApply = async (db: PowerSyncDb) => {
  await db.execute('UPDATE blocks_synced SET needs_apply = 1')
}

const idsByWindow = (fixture: MaterializeFixture, windowSize: number) => {
  const ids = fixture.blocks.map(block => block.id)
  const windows: string[][] = []
  for (let i = 0; i < ids.length; i += windowSize) windows.push(ids.slice(i, i + windowSize))
  return windows
}

/** Run the production materializer across bounded windows and return timings and SQL metrics. */
export const runMaterializePass = async (
  db: PowerSyncDb,
  fixture: MaterializeFixture,
  mode: MaterializeMode,
  key: CryptoKey,
  options: {windowSize?: number; getCek?: GetCek; metrics?: MaterializeMetrics} = {},
): Promise<MaterializePassResult> => {
  const windowSize = options.windowSize ?? DEFAULT_MATERIALIZE_WINDOW_SIZE
  const metrics = options.metrics ?? createMaterializeMetrics()
  const rawGetCek = options.getCek ?? (async () => key)
  const getCek: GetCek = async workspaceId => {
    const started = performance.now()
    metrics.keyCalls++
    try { return await rawGetCek(workspaceId) }
    finally { metrics.keyElapsedMs += performance.now() - started }
  }
  const deps: MaterializeDeps = {
    getMaterializability: () => mode === 'none' ? 'copy' as const : 'decrypt' as const,
    getCek,
    referenceTargetLookups: tx => ({
      aliasTargetId: async (alias: string, workspaceId: string) => {
        if (!alias || !workspaceId) return null
        const row = await tx.getOptional<{id: string}>(ALIAS_SQL, [workspaceId, alias])
        return row?.id ?? null
      },
    }),
  }
  const overallStart = performance.now()
  let totalPhase1Ms = 0
  let totalTransactionMs = 0
  let applied = 0
  let skippedStale = 0
  for (const upserted of idsByWindow(fixture, windowSize)) {
    let firstTxAt: number | null = null
    const instrumented = instrument(db, metrics, () => { firstTxAt = performance.now() })
    const beforeTx = metrics.txElapsedMs
    const started = performance.now()
    const outcome = await materializeStagingRows(instrumented, {upserted, removed: []}, deps)
    const txDelta = metrics.txElapsedMs - beforeTx
    totalPhase1Ms += firstTxAt === null ? performance.now() - started : firstTxAt - started
    totalTransactionMs += txDelta
    applied += outcome.applied.length
    skippedStale += outcome.skippedStale.length
    if (outcome.deferred.length || outcome.quarantined.length || outcome.applied.length + outcome.skippedStale.length !== upserted.length) {
      throw new Error(`Unexpected ${mode} materialization outcome: ${JSON.stringify({applied: outcome.applied.length, skipped: outcome.skippedStale.length, deferred: outcome.deferred.length, quarantined: outcome.quarantined.length})}`)
    }
  }
  metrics.phase1ElapsedMs = totalPhase1Ms
  metrics.txElapsedMs = totalTransactionMs
  return {metrics, wallMs: performance.now() - overallStart, applied, skippedStale}
}

export const validateMaterializeDb = async (
  db: PowerSyncDb, fixture: MaterializeFixture,
): Promise<MaterializeValidation> => {
  const rows = await db.getAll<BlockRow>(`SELECT id, workspace_id, parent_id, order_key, content, properties_json, references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted, reference_target_id, is_field_form FROM blocks`)
  const staged = await db.getAll<{needs_apply: number}>(`SELECT needs_apply FROM blocks_synced`)
  const uploads = await db.getAll<{n: number}>(`SELECT count(*) AS n FROM ps_crud`)
  if (rows.length !== fixture.blocks.length) throw new Error(`expected ${fixture.blocks.length} blocks, got ${rows.length}`)
  if (staged.some(row => row.needs_apply !== 0)) throw new Error('one or more blocks_synced rows still need apply')
  if ((uploads[0]?.n ?? -1) !== 0) throw new Error(`expected zero upload rows, got ${uploads[0]?.n}`)
  for (const row of rows) {
    const expected = fixture.expectedPlaintext.get(row.id)
    if (!expected || row.content !== expected.content || row.properties_json !== JSON.stringify(expected.properties)
      || row.references_json !== JSON.stringify(expected.references)) {
      throw new Error(`materialized values mismatch for ${row.id}`)
    }
    const expectedTarget = expected.references[0]?.id ?? null
    if (row.reference_target_id !== expectedTarget || (row.is_field_form === 1) !== fixture.fieldIds.has(row.id)) {
      throw new Error(`derived reference columns mismatch for ${row.id}`)
    }
  }
  const derivedReferenceTargets = rows.filter(row => row.reference_target_id !== null).length
  const derivedFieldForms = rows.filter(row => row.is_field_form === 1).length
  if (derivedReferenceTargets !== fixture.referenceCount) {
    throw new Error(`expected ${fixture.referenceCount} derived references, got ${derivedReferenceTargets}`)
  }
  if (derivedFieldForms !== fixture.fieldCount) {
    throw new Error(`expected ${fixture.fieldCount} field forms, got ${derivedFieldForms}`)
  }
  return {
    materializedRows: rows.length,
    needsApplyRemaining: staged.filter(row => row.needs_apply !== 0).length,
    uploads: uploads[0]?.n ?? -1,
    derivedReferenceTargets,
    derivedFieldForms,
  }
}
