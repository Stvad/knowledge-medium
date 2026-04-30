/**
 * Tiny bench harness for the data-layer perf suite.
 *
 *   - `bench(name, fn, opts)` runs warmup + measured iterations, returns
 *     stats (mean / p50 / p95 / p99 / min / max / stddev / ops-per-sec).
 *   - `instrumentDb(db)` wraps a PowerSyncDb with a counter that tallies
 *     `execute` / `getAll` / `getOptional` / `get` / `writeTransaction`
 *     calls — used to verify "tree walks push to SQL" by counting
 *     roundtrips per mutation.
 *   - `formatTable` / `formatResult` produce the markdown tables the
 *     runner prints to stdout and writes into `tmp/bench-results/...`.
 *
 * Adaptive iteration count: a benchmark runs `iters` if specified, else
 * iterates until `minMs` elapsed (default 500 ms) capped at 1000 iterations.
 * For O(s)-scale ops we want a few stable samples, not a fixed thousand.
 */

import type { PowerSyncDb } from '@/data/internals/commitPipeline'

export interface BenchOptions {
  warmup?: number
  iters?: number
  /** Adaptive cap — if `iters` is unset, run until total elapsed >= this
   *  (after warmup). Default 500 ms. */
  minMs?: number
  /** Hard cap on adaptive iters. Default 1000. */
  maxIters?: number
}

export interface BenchResult {
  name: string
  iterations: number
  totalMs: number
  meanMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  minMs: number
  maxMs: number
  stddevMs: number
  opsPerSec: number
  metadata?: Record<string, unknown>
}

export const bench = async (
  name: string,
  fn: () => Promise<void>,
  opts: BenchOptions = {},
): Promise<BenchResult> => {
  const warmup = opts.warmup ?? 3
  const minMs = opts.minMs ?? 500
  const maxIters = opts.maxIters ?? 1000
  const fixedIters = opts.iters

  // Warmup — discard.
  for (let i = 0; i < warmup; i++) await fn()

  const samples: number[] = []
  const t0 = performance.now()
  let i = 0
  while (true) {
    const s = performance.now()
    await fn()
    const e = performance.now()
    samples.push(e - s)
    i++
    if (fixedIters !== undefined) {
      if (i >= fixedIters) break
    } else {
      if (i >= maxIters) break
      if (e - t0 >= minMs && i >= 5) break
    }
  }

  const totalMs = samples.reduce((a, b) => a + b, 0)
  const sorted = samples.slice().sort((a, b) => a - b)
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  const mean = totalMs / samples.length
  const variance = samples.reduce((acc, s) => acc + (s - mean) * (s - mean), 0) / samples.length
  return {
    name,
    iterations: samples.length,
    totalMs,
    meanMs: mean,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    p99Ms: pct(0.99),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    stddevMs: Math.sqrt(variance),
    opsPerSec: 1000 / mean,
  }
}

/** SQL-roundtrip counter wrapped around a PowerSyncDb. The bench harness
 *  uses this to count how many SQL calls a single mutation makes — the
 *  Phase 5 acceptance is "subtree of 1000 blocks 5 levels deep = 1 SQL
 *  query"; this is how we measure that. */
export interface DbCounters {
  execute: number
  getAll: number
  getOptional: number
  get: number
  writeTransaction: number
  /** Snapshot the current counts. */
  snapshot: () => DbCounterSnapshot
  /** Reset all counters to zero. */
  reset: () => void
}

export interface DbCounterSnapshot {
  execute: number
  getAll: number
  getOptional: number
  get: number
  writeTransaction: number
  total: number
}

export const instrumentDb = (db: PowerSyncDb): {db: PowerSyncDb; counters: DbCounters} => {
  const state = {execute: 0, getAll: 0, getOptional: 0, get: 0, writeTransaction: 0}
  const counters: DbCounters = {
    get execute() { return state.execute },
    get getAll() { return state.getAll },
    get getOptional() { return state.getOptional },
    get get() { return state.get },
    get writeTransaction() { return state.writeTransaction },
    snapshot() {
      return {
        execute: state.execute,
        getAll: state.getAll,
        getOptional: state.getOptional,
        get: state.get,
        writeTransaction: state.writeTransaction,
        total: state.execute + state.getAll + state.getOptional + state.get,
      }
    },
    reset() {
      state.execute = 0
      state.getAll = 0
      state.getOptional = 0
      state.get = 0
      state.writeTransaction = 0
    },
  }
  // Instrument the inner LockContext on writeTransaction too — calls
  // inside `tx.execute` / `tx.getAll` count for "roundtrips inside this
  // mutation."
  const wrapTxDb = <T extends {execute: Function; getAll: Function; getOptional: Function; get: Function}>(txDb: T): T => ({
    ...txDb,
    execute: ((sql: string, params?: unknown[]) => { state.execute++; return txDb.execute(sql, params) }) as T['execute'],
    getAll: ((sql: string, params?: unknown[]) => { state.getAll++; return txDb.getAll(sql, params) }) as T['getAll'],
    getOptional: ((sql: string, params?: unknown[]) => { state.getOptional++; return txDb.getOptional(sql, params) }) as T['getOptional'],
    get: ((sql: string, params?: unknown[]) => { state.get++; return txDb.get(sql, params) }) as T['get'],
  })

  const wrapped: PowerSyncDb = {
    execute: (sql, params) => { state.execute++; return db.execute(sql, params) },
    getAll: (sql, params) => { state.getAll++; return db.getAll(sql, params) },
    getOptional: (sql, params) => { state.getOptional++; return db.getOptional(sql, params) },
    get: (sql, params) => { state.get++; return db.get(sql, params) },
    writeTransaction: (fn) => {
      state.writeTransaction++
      return db.writeTransaction((txDb) => fn(wrapTxDb(txDb)))
    },
    onChange: (h, opts) => db.onChange(h, opts),
  }
  return {db: wrapped, counters}
}

/** Pretty-print a row of bench results as a markdown row. */
export const formatRow = (r: BenchResult): string => {
  const md = r.metadata ? Object.entries(r.metadata).map(([k, v]) => `${k}=${v}`).join(' ') : ''
  return [
    `| ${r.name}`,
    `${r.iterations}`,
    `${r.meanMs.toFixed(3)}`,
    `${r.p50Ms.toFixed(3)}`,
    `${r.p95Ms.toFixed(3)}`,
    `${r.p99Ms.toFixed(3)}`,
    `${r.minMs.toFixed(3)}`,
    `${r.maxMs.toFixed(3)}`,
    `${r.opsPerSec.toFixed(1)}`,
    `${md} |`,
  ].join(' | ')
}

export const TABLE_HEADER =
  '| name | n | mean (ms) | p50 | p95 | p99 | min | max | ops/s | meta |\n' +
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'

export const formatTable = (results: readonly BenchResult[]): string =>
  [TABLE_HEADER, ...results.map(formatRow)].join('\n')

/** Wall-clock helper for one-shot timings (e.g. "build fixture of 50k blocks"). */
export const time = async <T>(fn: () => Promise<T>): Promise<{value: T; ms: number}> => {
  const s = performance.now()
  const value = await fn()
  return {value, ms: performance.now() - s}
}
