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
  if (!Number.isInteger(records) || records < 1) throw new Error('--records must be a positive integer')
  if (!Number.isInteger(reps) || reps < 1) throw new Error('--reps must be a positive integer')
  return {records, reps, workflow}
}

const round = (n: number) => Math.round(n * 100) / 100

const printMetric = (
  scenario: string, mode: MaterializeMode, records: number,
  result: Awaited<ReturnType<typeof runMaterializePass>>,
  validation: Awaited<ReturnType<typeof validateMaterializeDb>>,
) => {
  const {metrics} = result
  const sqlCalls = Object.values(metrics.calls).reduce((sum, m) => sum + m.count, 0)
  const sqlCallMs = Object.values(metrics.calls).reduce((sum, m) => sum + m.elapsedMs, 0)
  console.log(JSON.stringify({
    scenario, mode, records, windowSize: 1000, windows: Math.ceil(records / 1000),
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

const main = async () => {
  const {records, reps, workflow} = parseArgs(process.argv.slice(2))
  const fixture = makeMaterializeFixture(records)
  const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'])
  const env = await createTestDb()
  const db = env.db as unknown as PowerSyncDb
  try {
    const modes: readonly MaterializeMode[] = ['none', 'e2ee']
    const prepared = new Map<MaterializeMode, Awaited<ReturnType<typeof makeMaterializeWireRows>>>()
    for (const mode of modes) prepared.set(mode, await makeMaterializeWireRows(fixture, mode, key))
    for (const mode of modes) {
      for (const scenario of ['initial', 'echo-repass'] as const) {
        for (let sample = -1; sample < reps; sample++) {
          await resetTestDb(env.db)
          await stageMaterializeRows(db, fixture, prepared.get(mode)!)
          if (scenario === 'echo-repass') {
            await runMaterializePass(db, fixture, mode, key)
            await resetMaterializeNeedsApply(db)
          }
          const result = await runMaterializePass(db, fixture, mode, key, {metrics: createMaterializeMetrics()})
          const validation = await validateMaterializeDb(db, fixture)
          if (sample >= 0) printMetric(scenario, mode, records, result, validation)
        }
      }
    }
    const workflowSamples = workflow
      ? await runMaterializeWorkflowBench(db, () => resetTestDb(env.db), fixture, prepared.get('e2ee')!, key, reps)
      : undefined
    if (workflowSamples) for (const sample of workflowSamples) console.log(JSON.stringify({workflowSample: sample}))
    console.log(JSON.stringify({complete: true, records, reps, warmups: 1, windowSize: 1000, workflow, fixture: {
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
