/**
 * Scale stress benchmarks. Big-DB baseline + deep/wide tree shapes.
 *
 *   - Big-DB baseline: populate 50k flat blocks, then re-run setContent
 *     and load to see if either degrades with DB size.
 *   - Linear chain depth 1k / 5k / 10k: ANCESTORS + IS_DESCENDANT_OF
 *     + indent at the leaf.
 *   - Wide fan-out 10k / 50k siblings: insertChildren of 10 items at
 *     'first' (worst case — pre-existing siblings dominate the keyBetween
 *     neighbor lookup), CHILDREN_SQL ordering.
 *   - Memory growth rate: process.memoryUsage().heapUsed delta after
 *     populating N blocks (10k / 50k / 100k). Coarse, but captures
 *     "BlockCache has no eviction" reality.
 *
 * Some of these populate 100k+ rows and take meaningful wall time —
 * they're guarded behind the `--scale` flag in the runner. Defaults to
 * "small" for smoke runs.
 */

import { ChangeScope } from '@/data/api'
import { ANCESTORS_SQL, IS_DESCENDANT_OF_SQL, SUBTREE_SQL } from '@/data/internals/treeQueries'
import { bench, time, type BenchResult } from './harness'
import { setupBenchEnv } from './setup'
import {
  populateFanOut,
  populateFlat,
  populateLinearChain,
} from './fixtures'

export const runScaleBenches = async (opts: {full?: boolean} = {}): Promise<BenchResult[]> => {
  const out: BenchResult[] = []
  const full = opts.full ?? false

  // ──── Big-DB baseline: populate N flat, then re-run hot paths ────
  for (const dbSize of full ? [10000, 50000, 100000] : [10000, 50000]) {
    const env = await setupBenchEnv({instrumented: true})
    const memBefore = process.memoryUsage()
    const tPop = await time(() => populateFlat(env.db, dbSize))
    const memAfter = process.memoryUsage()

    // Populate-time row.
    out.push({
      name: `populateFlat (n=${dbSize}) — wall time`,
      iterations: 1, totalMs: tPop.ms, meanMs: tPop.ms,
      p50Ms: tPop.ms, p95Ms: tPop.ms, p99Ms: tPop.ms,
      minMs: tPop.ms, maxMs: tPop.ms, stddevMs: 0, opsPerSec: dbSize / (tPop.ms / 1000),
      metadata: {
        rowsPerSec: (dbSize / (tPop.ms / 1000)).toFixed(0),
        heapMB: ((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(1),
        rssMB: ((memAfter.rss - memBefore.rss) / 1024 / 1024).toFixed(1),
      },
    })

    // Pick a target row from the populated set.
    const target = tPop.value.ids[Math.floor(dbSize / 2)]
    await env.repo.load(target)
    let i = 0
    env.counters!.reset()
    const r = await bench(`mutate.setContent (DB size=${dbSize})`, async () => {
      await env.repo.mutate['core.setContent']({id: target, content: `c-${i++}`})
    }, {warmup: 3, maxIters: 50})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1), dbSize}
    out.push(r)

    // Cold load against big DB.
    env.counters!.reset()
    const r2 = await bench(`repo.load(id) cold (DB size=${dbSize})`, async () => {
      env.cache.deleteSnapshot(target)
      await env.repo.load(target)
    }, {warmup: 3, maxIters: 100})
    const snap2 = env.counters!.snapshot()
    r2.metadata = {sql: (snap2.total / r2.iterations).toFixed(1), dbSize}
    out.push(r2)

    await env.cleanup()
  }

  // ──── Deep linear chains ────
  for (const depth of full ? [1000, 5000, 10000] : [1000, 5000]) {
    const env = await setupBenchEnv({instrumented: true})
    const tPop = await time(() => populateLinearChain(env.db, depth))
    out.push({
      name: `populateLinearChain (depth=${depth}) — wall time`,
      iterations: 1, totalMs: tPop.ms, meanMs: tPop.ms,
      p50Ms: tPop.ms, p95Ms: tPop.ms, p99Ms: tPop.ms,
      minMs: tPop.ms, maxMs: tPop.ms, stddevMs: 0, opsPerSec: depth / (tPop.ms / 1000),
      metadata: {rowsPerSec: (depth / (tPop.ms / 1000)).toFixed(0)},
    })

    // ANCESTORS_SQL on the leaf — depth deep climbs.
    const r1 = await bench(`ANCESTORS_SQL leaf (depth=${depth})`, async () => {
      await env.db.getAll(ANCESTORS_SQL, [tPop.value.leafId, tPop.value.leafId])
    }, {warmup: 1, iters: 5})
    r1.metadata = {depth}
    out.push(r1)

    // IS_DESCENDANT_OF_SQL — leaf is a descendant of root, full walk.
    const r2 = await bench(`IS_DESCENDANT_OF_SQL leaf-of-root (depth=${depth})`, async () => {
      await env.db.getAll(IS_DESCENDANT_OF_SQL, [tPop.value.leafId, tPop.value.rootId])
    }, {warmup: 1, iters: 5})
    r2.metadata = {depth}
    out.push(r2)

    // SUBTREE_SQL from root — full subtree (single linear chain so depth = N).
    const r3 = await bench(`SUBTREE_SQL root (depth=${depth} chain)`, async () => {
      await env.db.getAll(SUBTREE_SQL, [tPop.value.rootId])
    }, {warmup: 1, iters: 5})
    r3.metadata = {depth}
    out.push(r3)

    await env.cleanup()
  }

  // ──── Wide fan-out ────
  for (const width of full ? [10000, 50000] : [10000]) {
    const env = await setupBenchEnv({instrumented: true})
    const tPop = await time(() => populateFanOut(env.db, width))
    out.push({
      name: `populateFanOut (width=${width}) — wall time`,
      iterations: 1, totalMs: tPop.ms, meanMs: tPop.ms,
      p50Ms: tPop.ms, p95Ms: tPop.ms, p99Ms: tPop.ms,
      minMs: tPop.ms, maxMs: tPop.ms, stddevMs: 0, opsPerSec: width / (tPop.ms / 1000),
      metadata: {rowsPerSec: (width / (tPop.ms / 1000)).toFixed(0)},
    })

    // insertChildren at first (worst-case neighbor lookup).
    const items = Array.from({length: 10}, (_, i) => ({content: `wide-bulk-${i}`}))
    env.counters!.reset()
    const r1 = await bench(`mutate.insertChildren (n=10 at front, ${width} sibs)`, async () => {
      await env.repo.mutate['core.insertChildren']({parentId: tPop.value.parentId, items, position: {kind: 'first'}})
    }, {warmup: 1, iters: 5})
    const snap1 = env.counters!.snapshot()
    r1.metadata = {sql: (snap1.total / r1.iterations).toFixed(1), wtx: snap1.writeTransaction, width}
    out.push(r1)

    // childrenOf via tx (read SQL through the writeTransaction).
    const r2 = await bench(`tx.childrenOf (parent has ${width} sibs)`, async () => {
      await env.repo.tx(async (tx) => {
        await tx.childrenOf(tPop.value.parentId)
      }, {scope: ChangeScope.BlockDefault})
    }, {warmup: 1, iters: 5})
    r2.metadata = {width}
    out.push(r2)

    await env.cleanup()
  }

  // ──── Memory growth rate (BlockCache has no eviction) ────
  // Coarse: load N blocks into the cache, observe heap delta.
  for (const N of full ? [10000, 50000, 100000] : [10000, 50000]) {
    const env = await setupBenchEnv()
    const tPop = await time(() => populateFlat(env.db, N))
    const memBeforeLoad = process.memoryUsage()
    // Load each row into the cache.
    for (const id of tPop.value.ids) {
      await env.repo.load(id)
    }
    if (global.gc) global.gc()
    const memAfterLoad = process.memoryUsage()
    out.push({
      name: `cache memory growth (N=${N} loaded)`,
      iterations: 1, totalMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0,
      minMs: 0, maxMs: 0, stddevMs: 0, opsPerSec: 0,
      metadata: {
        N,
        heapMB: ((memAfterLoad.heapUsed - memBeforeLoad.heapUsed) / 1024 / 1024).toFixed(1),
        bytesPerBlock: Math.round((memAfterLoad.heapUsed - memBeforeLoad.heapUsed) / N).toString(),
        rssMB: ((memAfterLoad.rss - memBeforeLoad.rss) / 1024 / 1024).toFixed(1),
      },
    })
    await env.cleanup()
  }

  return out
}
