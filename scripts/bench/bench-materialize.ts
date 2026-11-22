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
import type { PowerSyncDb } from '@/data/internals/commitPipeline.js'
import { makeMaterializeFixture } from './materialize-fixture.js'
import {
  makeMaterializeWireRows,
  runMaterializePass,
  validateMaterializeDb,
  type MaterializeMode,
} from './materialize-benchmark-core.js'
import {
  round, runVariantSamples, validateVariantOptions, variantInfoOf,
  type Scenario, type VariantOptions,
} from './materialize-variants.js'
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
  const modes = (list('--modes') ?? ['none', 'e2ee']) as MaterializeMode[]
  const scenarios = (list('--scenarios') ?? ['initial', 'echo-repass']) as Scenario[]
  const dropTriggers = list('--drop-triggers') ?? []
  const randomIds = argv.includes('--random-ids')
  const rebuildDerived = argv.includes('--rebuild-derived')
  const dropIndexes = argv.includes('--drop-indexes')
  const bulkLoad = argv.includes('--bulk-load')
  const perRowFts = argv.includes('--per-row-fts')
  const cacheKb = argv.includes('--cache-kb') ? value('--cache-kb', NaN) : undefined
  const options: VariantOptions = {window, modes, scenarios, dropTriggers, dropIndexes, rebuildDerived, randomIds, cacheKb, bulkLoad, perRowFts}
  validateVariantOptions({...options, records, reps})
  return {records, reps, workflow, options}
}

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
    ...(metrics.deferredIndexMs ? {deferredIndexMs: round(metrics.deferredIndexMs)} : {}),
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

/** Node's test DB has one writer and one reader connection (`readWorkerCount: 1`), each with its
 *  own page cache; split the total across them as production does. Both are reachable: the writer
 *  through `execute`, the reader through `readLock`. */
const capPageCache = async (db: PowerSyncDb, totalKb: number) => {
  const perConnection = Math.floor(totalKb / 2)
  await db.execute(`PRAGMA cache_size = -${perConnection}`)
  const reader = db as unknown as {readLock<R>(fn: (ctx: {getAll: PowerSyncDb['getAll']}) => Promise<R>): Promise<R>}
  await reader.readLock(ctx => ctx.getAll(`PRAGMA cache_size = -${perConnection}`))
}

const main = async () => {
  const {records, reps, workflow, options} = parseArgs(process.argv.slice(2))
  const {window, modes, scenarios, randomIds} = options
  const fixture = makeMaterializeFixture(records, {randomIds})
  const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'])
  const env = await createTestDb()
  const db = env.db as unknown as PowerSyncDb
  try {
    const variantInfo = variantInfoOf(options)
    if (options.cacheKb !== undefined) await capPageCache(db, options.cacheKb)
    const prepared = new Map<MaterializeMode, Awaited<ReturnType<typeof makeMaterializeWireRows>>>()
    for (const mode of modes) prepared.set(mode, await makeMaterializeWireRows(fixture, mode, key))
    await runVariantSamples({
      db, resetDb: () => resetTestDb(env.db), fixture, key, prepared, options,
      connections: 2,
      onSample: ({scenario, mode, sample, result, validation, extra}) => {
        if (sample >= 0) printMetric(scenario, mode, records, result, validation, window, extra)
      },
    }, reps)
    const workflowSamples = workflow
      ? await runMaterializeWorkflowBench(db, () => resetTestDb(env.db), fixture, prepared.get('e2ee') ?? await makeMaterializeWireRows(fixture, 'e2ee', key), key, reps)
      : undefined
    if (workflowSamples) for (const sample of workflowSamples) console.log(JSON.stringify({workflowSample: sample}))
    console.log(JSON.stringify({complete: true, records, reps, warmups: 1, windowSize: window, workflow, ...variantInfo,
      ...(options.rebuildDerived ? {rebuildDerived: true} : {}), ...(modes.length !== 2 || scenarios.length !== 2 ? {modes, scenarios} : {}), fixture: {
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
