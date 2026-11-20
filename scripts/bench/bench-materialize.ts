/**
 * Reproducible synthetic initial-workspace materialization benchmark.
 *
 * Run with:
 *   pnpm exec vite-node --config vitest.config.ts scripts/bench/bench-materialize.ts
 *   pnpm exec vite-node --config vitest.config.ts scripts/bench/bench-materialize.ts --records 10000 --reps 3
 *
 * The portable fixture and measured engine live in materialize-fixture.ts and
 * materialize-benchmark-core.ts so browser benchmarks can share exact inputs.
 */

import { createTestDb, resetTestDb } from '@/data/test/createTestDb.js'
import {
  BACKFILL_BLOCK_ALIASES_SQL,
  BACKFILL_BLOCK_TYPES_SQL,
  BACKFILL_BLOCKS_FTS_ROWIDS_SQL,
  BACKFILL_BLOCKS_FTS_SQL,
} from '@/data/internals/clientSchema.js'
import type { PowerSyncDb } from '@/data/internals/commitPipeline.js'
import { makeMaterializeFixture } from './materialize-fixture.js'
import {
  createMaterializeMetrics,
  makeMaterializeWireRows,
  resetMaterializeNeedsApply,
  runMaterializePass,
  stageMaterializeRows,
  validateMaterializeDb,
  type MaterializeMode,
} from './materialize-benchmark-core.js'
import { runMaterializeWorkflowBench } from './materialize-workflow.js'

const parseArgs = (argv: string[]) => {
  const value = (flag: string, fallback: number) => {
    const index = argv.indexOf(flag)
    return index < 0 ? fallback : Number(argv[index + 1])
  }
  const records = value('--records', 10_000)
  const reps = value('--reps', 3)
  const workflow = argv.includes('--workflow')
  const list = (flag: string) => {
    const index = argv.indexOf(flag)
    return index < 0 ? undefined : argv[index + 1].split(',').filter(Boolean)
  }
  const window = value('--window', 1000)
  if (!Number.isInteger(window) || window < 1) throw new Error('--window must be a positive integer')
  const modes = (list('--modes') ?? ['none', 'e2ee']) as MaterializeMode[]
  const scenarios = (list('--scenarios') ?? ['initial', 'echo-repass']) as Scenario[]
  for (const m of modes) if (m !== 'none' && m !== 'e2ee') throw new Error(`unknown mode ${m}`)
  for (const sc of scenarios) if (sc !== 'initial' && sc !== 'echo-repass') throw new Error(`unknown scenario ${sc}`)
  const dropTriggers = list('--drop-triggers') ?? []
  for (const t of dropTriggers) if (!/^\w+$/.test(t)) throw new Error(`bad trigger name ${t}`)
  const randomIds = argv.includes('--random-ids')
  const rebuildDerived = argv.includes('--rebuild-derived')
  if (!Number.isInteger(records) || records < 1) throw new Error('--records must be a positive integer')
  if (!Number.isInteger(reps) || reps < 1) throw new Error('--reps must be a positive integer')
  return {records, reps, workflow, window, modes, scenarios, dropTriggers, randomIds, rebuildDerived}
}

type Scenario = 'initial' | 'echo-repass'

const round = (n: number) => Math.round(n * 100) / 100

const printMetric = (
  scenario: string, mode: MaterializeMode, records: number,
  result: Awaited<ReturnType<typeof runMaterializePass>>,
  validation: Awaited<ReturnType<typeof validateMaterializeDb>>,
  windowSize: number, extra: Record<string, unknown> = {},
) => {
  const {metrics} = result
  const sqlCalls = Object.values(metrics.calls).reduce((sum, m) => sum + m.count, 0)
  const sqlCallMs = Object.values(metrics.calls).reduce((sum, m) => sum + m.elapsedMs, 0)
  console.log(JSON.stringify({
    scenario, mode, records, windowSize, windows: Math.ceil(records / windowSize), ...extra,
    wallMs: round(result.wallMs), phase1Ms: round(metrics.phase1ElapsedMs),
    writeTransactionMs: round(metrics.txElapsedMs), keyCalls: metrics.keyCalls,
    keyLookupMs: round(metrics.keyElapsedMs),
    dbCalls: Object.fromEntries(Object.entries(metrics.calls)
      .map(([name, m]) => [name, {count: m.count, elapsedMs: round(m.elapsedMs)}])),
    sqlCalls, summedSqlCallMs: round(sqlCallMs), uniqueSql: metrics.sql.size,
    statements: [...metrics.sql.entries()]
      .map(([sql, m]) => ({sql, count: m.count, elapsedMs: round(m.elapsedMs)})),
    applied: result.applied, skippedStale: result.skippedStale, validation,
  }))
}

const dropTriggerList = async (db: PowerSyncDb, names: string[]) => {
  for (const name of names) await db.execute(`DROP TRIGGER IF EXISTS ${name}`)
}

/** One timed set-based rebuild per derived table, with the production backfill statements. */
const rebuildDerivedTables = async (db: PowerSyncDb) => {
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

const derivedCounts = async (db: PowerSyncDb) => {
  const count = async (table: string) =>
    (await db.getAll<{n: number}>(`SELECT count(*) AS n FROM ${table}`))[0]?.n ?? -1
  return {
    block_aliases: await count('block_aliases'), block_types: await count('block_types'),
    blocks_fts_rowids: await count('blocks_fts_rowids'), blocks_fts: await count('blocks_fts'),
    row_events: await count('row_events'),
  }
}

const main = async () => {
  const {records, reps, workflow, window, modes: modeList, scenarios, dropTriggers, randomIds, rebuildDerived}
    = parseArgs(process.argv.slice(2))
  const fixture = makeMaterializeFixture(records, {randomIds})
  const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'])
  const env = await createTestDb()
  const db = env.db as unknown as PowerSyncDb
  try {
    const variantInfo: Record<string, unknown> = {
      ...(randomIds ? {randomIds} : {}),
      ...(dropTriggers.length ? {droppedTriggers: dropTriggers} : {}),
    }
    // Alias references resolve through block_aliases, which blocks_alias_insert fills; without it
    // reference_target_id/is_field_form are legitimately not derived, so skip only that validation.
    const skipDerivedReferenceChecks = dropTriggers.includes('blocks_alias_insert')
    if (skipDerivedReferenceChecks) variantInfo.skippedDerivedReferenceValidation = true
    await dropTriggerList(db, dropTriggers)
    const modes: readonly MaterializeMode[] = modeList
    const prepared = new Map<MaterializeMode, Awaited<ReturnType<typeof makeMaterializeWireRows>>>()
    for (const mode of modes) prepared.set(mode, await makeMaterializeWireRows(fixture, mode, key))
    for (const mode of modes) {
      for (const scenario of scenarios) {
        for (let sample = -1; sample < reps; sample++) {
          await resetTestDb(env.db)
          await stageMaterializeRows(db, fixture, prepared.get(mode)!)
          if (scenario === 'echo-repass') {
            await runMaterializePass(db, fixture, mode, key)
            await resetMaterializeNeedsApply(db)
          }
          const result = await runMaterializePass(db, fixture, mode, key, {metrics: createMaterializeMetrics(), windowSize: window})
          const validation = await validateMaterializeDb(db, fixture, {skipDerivedReferenceChecks})
          const extra: Record<string, unknown> = {...variantInfo}
          if (rebuildDerived) {
            const before = await derivedCounts(db)
            extra.rebuildMs = await rebuildDerivedTables(db)
            extra.derivedCountsBeforeRebuild = before
            extra.derivedCountsAfterRebuild = await derivedCounts(db)
          } else if (dropTriggers.length || randomIds) extra.derivedCounts = await derivedCounts(db)
          if (sample >= 0) printMetric(scenario, mode, records, result, validation, window, extra)
        }
      }
    }
    const workflowSamples = workflow
      ? await runMaterializeWorkflowBench(db, () => resetTestDb(env.db), fixture, prepared.get('e2ee') ?? await makeMaterializeWireRows(fixture, 'e2ee', key), key, reps)
      : undefined
    if (workflowSamples) for (const sample of workflowSamples) console.log(JSON.stringify({workflowSample: sample}))
    console.log(JSON.stringify({complete: true, records, reps, warmups: 1, windowSize: window, workflow, ...variantInfo,
      ...(rebuildDerived ? {rebuildDerived} : {}), ...(modeList.length !== 2 || scenarios.length !== 2 ? {modes: modeList, scenarios} : {}), fixture: {
      plainTextRows: records - fixture.aliasCount - fixture.referenceCount,
      aliasRows: fixture.aliasCount, referenceRows: fixture.referenceCount, fieldRows: fixture.fieldCount,
    }}))
  } finally {
    await env.cleanup()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
