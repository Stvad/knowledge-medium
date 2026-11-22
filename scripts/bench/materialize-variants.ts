/**
 * Variant flags shared by the Node and browser materialization runners: dropped
 * triggers/indexes, derived-table rebuilds, page-cache accounting, and the
 * sample loop itself. Browser-safe (no Node imports).
 */

import {
  BACKFILL_BLOCK_ALIASES_SQL,
  BACKFILL_BLOCK_TYPES_SQL,
  BACKFILL_BLOCKS_FTS_ROWIDS_SQL,
  BACKFILL_BLOCKS_FTS_SQL,
  CREATE_BLOCKS_FTS_INSERT_TRIGGER_SQL,
} from '@/data/internals/clientSchema'
import type { PowerSyncDb } from '@/data/internals/commitPipeline'
import type { MaterializeFixture } from './materialize-fixture'
import {
  createMaterializeMetrics,
  resetMaterializeNeedsApply,
  runMaterializePass,
  stageMaterializeRows,
  validateMaterializeDb,
  type MaterializeMode,
  type MaterializePassResult,
  type MaterializeValidation,
  type MaterializeWireRows,
} from './materialize-benchmark-core'
import type { GetCek } from '@/sync/transform'

export type Scenario = 'initial' | 'echo-repass'

export interface VariantOptions {
  window: number
  modes: MaterializeMode[]
  scenarios: Scenario[]
  dropTriggers: string[]
  dropIndexes: boolean
  rebuildDerived: boolean
  randomIds: boolean
  /** Run the production bulk hold (`runMaterializePass`'s `bulkLoad`). */
  bulkLoad: boolean
  /** With `bulkLoad`: index every insert per row, as the hold did before the
   *  search index was deferred — the baseline for that change. */
  perRowFts: boolean
  /** Total page cache across connections, KiB; undefined leaves the runner's default. */
  cacheKb?: number
}

export const round = (n: number) => Math.round(n * 100) / 100

export const validateVariantOptions = (o: VariantOptions & {records: number; reps: number}) => {
  if (!Number.isInteger(o.records) || o.records < 1) throw new Error('--records must be a positive integer')
  if (!Number.isInteger(o.reps) || o.reps < 1) throw new Error('--reps must be a positive integer')
  if (!Number.isInteger(o.window) || o.window < 1) throw new Error('--window must be a positive integer')
  for (const m of o.modes) if (m !== 'none' && m !== 'e2ee') throw new Error(`unknown mode ${m}`)
  for (const sc of o.scenarios) if (sc !== 'initial' && sc !== 'echo-repass') throw new Error(`unknown scenario ${sc}`)
  for (const t of o.dropTriggers) if (!/^\w+$/.test(t)) throw new Error(`bad trigger name ${t}`)
  if (o.perRowFts && !o.bulkLoad) throw new Error('--per-row-fts needs --bulk-load')
  if (o.cacheKb !== undefined && (!Number.isInteger(o.cacheKb) || o.cacheKb < 1)) {
    throw new Error('--cache-kb must be a positive integer')
  }
}

export const dropTriggerList = async (db: PowerSyncDb, names: string[]) => {
  for (const name of names) await db.execute(`DROP TRIGGER IF EXISTS ${name}`)
}

/** `--per-row-fts`: `blocks_fts_insert` without its bulk-load WHEN, and no deferral. */
export const restorePerRowFts = async (db: PowerSyncDb) => {
  await dropTriggerList(db, ['blocks_fts_insert', 'blocks_fts_insert_deferred'])
  await db.execute(CREATE_BLOCKS_FTS_INSERT_TRIGGER_SQL.replace(/WHEN NOT [\s\S]*?(?=\n\s*BEGIN)/, ''))
}

export interface DroppedIndex { name: string; sql: string }

/** Secondary indexes on `blocks` (autoindexes have null sql and are excluded). */
export const listBlocksIndexes = (db: PowerSyncDb) =>
  db.getAll<DroppedIndex>(
    `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'blocks' AND sql IS NOT NULL ORDER BY name`,
  )

export const dropIndexes = async (db: PowerSyncDb, indexes: DroppedIndex[]) => {
  for (const {name} of indexes) await db.execute(`DROP INDEX IF EXISTS "${name}"`)
}

export const recreateIndexes = async (db: PowerSyncDb, indexes: DroppedIndex[]) => {
  const timings: {name: string; ms: number}[] = []
  for (const {name, sql} of indexes) {
    const started = performance.now()
    await db.execute(sql)
    timings.push({name, ms: round(performance.now() - started)})
  }
  return timings
}

/** One timed set-based rebuild per derived table, with the production backfill statements. */
export const rebuildDerivedTables = async (db: PowerSyncDb) => {
  const timed = async (label: string, sql: string) => {
    const started = performance.now()
    await db.execute(sql)
    return {label, ms: round(performance.now() - started)}
  }
  return [
    await timed('block_aliases', BACKFILL_BLOCK_ALIASES_SQL),
    await timed('block_types', BACKFILL_BLOCK_TYPES_SQL),
    await timed('blocks_fts_rowids', BACKFILL_BLOCKS_FTS_ROWIDS_SQL),
    await timed('blocks_fts', BACKFILL_BLOCKS_FTS_SQL),
  ]
}

export const derivedCounts = async (db: PowerSyncDb) => {
  const count = async (table: string) =>
    (await db.getAll<{n: number}>(`SELECT count(*) AS n FROM ${table}`))[0]?.n ?? -1
  return {
    block_aliases: await count('block_aliases'), block_types: await count('block_types'),
    blocks_fts_rowids: await count('blocks_fts_rowids'), blocks_fts: await count('blocks_fts'),
    blocks_fts_owed: await count('blocks_fts_owed'),
    row_events: await count('row_events'),
  }
}

/** Pragmas as seen by one reader and the writer. `getAll` goes to a reader
 *  connection where the runner has one, `execute` to the writer. */
export const readPragma = async (db: PowerSyncDb, name: string) => {
  const sql = `PRAGMA ${name}`
  const pick = (rows: Record<string, unknown>[]) => Object.values(rows[0] ?? {})[0] ?? null
  const writer = await db.execute(sql) as {rows?: {_array?: Record<string, unknown>[]}} | undefined
  const reader = await db.getAll<Record<string, unknown>>(sql)
  return {writer: pick(writer?.rows?._array ?? []), reader: pick(reader)}
}

/** `connections` is how many connections hold a cache of their own: on a
 *  single-connection runner the writer and reader pragmas describe one cache. */
export const cacheInfo = async (db: PowerSyncDb, connections: 1 | 2) => {
  const pageSize = Number((await readPragma(db, 'page_size')).reader)
  const pageCount = Number((await readPragma(db, 'page_count')).reader)
  const cache = await readPragma(db, 'cache_size')
  const fileKb = Math.round(pageSize * pageCount / 1024)
  // cache_size < 0 means KiB, > 0 means pages
  const kb = (v: unknown) => (Number(v) < 0 ? -Number(v) : Number(v) * pageSize / 1024)
  const cachedKb = connections === 1 ? kb(cache.writer) : kb(cache.writer) + kb(cache.reader)
  return {
    pageSize, pageCount, fileKb, cacheSize: cache,
    cachedFraction: fileKb > 0 ? round(Math.min(1, cachedKb / fileKb)) : null,
  }
}

export interface VariantSample {
  scenario: Scenario
  mode: MaterializeMode
  /** -1 is the discarded warmup. */
  sample: number
  result: MaterializePassResult
  validation: MaterializeValidation
  extra: Record<string, unknown>
}

export interface VariantEnv {
  /** Connections with their own page cache (writer, plus a reader if any). */
  connections: 1 | 2
  db: PowerSyncDb
  resetDb: () => Promise<void>
  fixture: MaterializeFixture
  key: CryptoKey
  getCek?: GetCek
  prepared: Map<MaterializeMode, MaterializeWireRows>
  options: VariantOptions
  onSample: (sample: VariantSample) => void | Promise<void>
}

/** Describes the variant for the output (empty for the defaults). */
export const variantInfoOf = (o: VariantOptions): Record<string, unknown> => ({
  ...(o.randomIds ? {randomIds: o.randomIds} : {}),
  ...(o.dropTriggers.length ? {droppedTriggers: o.dropTriggers} : {}),
  ...(o.dropIndexes ? {droppedIndexes: true} : {}),
  ...(o.bulkLoad ? {bulkLoad: true} : {}),
  ...(o.perRowFts ? {perRowFts: true} : {}),
  ...(o.cacheKb !== undefined ? {cacheKb: o.cacheKb} : {}),
  // Alias references resolve through block_aliases, which blocks_alias_insert fills; without it
  // reference_target_id/is_field_form are legitimately not derived, so skip only that validation.
  ...(o.dropTriggers.includes('blocks_alias_insert') ? {skippedDerivedReferenceValidation: true} : {}),
})

/** The warmup + measured sample loop shared by both runners. */
export const runVariantSamples = async (env: VariantEnv, reps: number) => {
  const {db, fixture, key, options} = env
  const skipDerivedReferenceChecks = options.dropTriggers.includes('blocks_alias_insert')
  const variantInfo = variantInfoOf(options)
  await dropTriggerList(db, options.dropTriggers)
  if (options.perRowFts) await restorePerRowFts(db)
  const indexes = options.dropIndexes ? await listBlocksIndexes(db) : []
  for (const mode of options.modes) {
    for (const scenario of options.scenarios) {
      for (let sample = -1; sample < reps; sample++) {
        await env.resetDb()
        if (options.dropIndexes) await dropIndexes(db, indexes)
        await stageMaterializeRows(db, fixture, env.prepared.get(mode)!)
        if (scenario === 'echo-repass') {
          await runMaterializePass(db, fixture, mode, key, {getCek: env.getCek})
          await resetMaterializeNeedsApply(db)
        }
        const result = await runMaterializePass(db, fixture, mode, key, {
          metrics: createMaterializeMetrics(), windowSize: options.window, getCek: env.getCek,
          bulkLoad: options.bulkLoad,
        })
        const validation = await validateMaterializeDb(db, fixture, {skipDerivedReferenceChecks})
        const extra: Record<string, unknown> = {...variantInfo}
        if (options.cacheKb !== undefined || options.dropIndexes) extra.cache = await cacheInfo(db, env.connections)
        if (options.dropIndexes) extra.droppedIndexNames = indexes.map(i => i.name)
        if (options.rebuildDerived) {
          const before = await derivedCounts(db)
          extra.rebuildMs = await rebuildDerivedTables(db)
          if (options.dropIndexes) extra.recreateIndexMs = await recreateIndexes(db, indexes)
          extra.derivedCountsBeforeRebuild = before
          extra.derivedCountsAfterRebuild = await derivedCounts(db)
        } else if (options.dropTriggers.length || options.randomIds) extra.derivedCounts = await derivedCounts(db)
        await env.onSample({scenario, mode, sample, result, validation, extra})
      }
    }
  }
}
