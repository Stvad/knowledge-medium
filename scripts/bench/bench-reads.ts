/**
 * Read-path benchmarks: cold loads, neighborhood loads, raw CTEs, and
 * the §2 goal #7 verification ("tree walks push to SQL").
 *
 *   - repo.load(id) cold → single SQL.
 *   - repo.load(id, {children/ancestors/descendants}) at varying scale.
 *   - Raw SUBTREE_SQL / ANCESTORS_SQL / IS_DESCENDANT_OF_SQL / CHILDREN_SQL.
 *   - repo.query.subtree({id}) cold (Handle) — verifies the §2 #7
 *     single-query promise: subtree of 1000 blocks 5 levels deep should
 *     be 1 SQL call.
 *   - "Cold-start journal page": ancestors+descendants neighborhood load
 *     for a typical page, count SQL roundtrips (the Phase 2 acceptance
 *     proxy for "open daily note → minimal queries").
 *
 * Post-Phase-4 note: legacy `repo.subtree(id)` / `repo.ancestors(id)` /
 * `repo.children(id)` factories were deleted in chunk C-2; everything
 * routes through `repo.query.X({...})` now.
 */

import {
  ANCESTORS_SQL,
  CHILDREN_SQL,
  IS_DESCENDANT_OF_SQL,
  SUBTREE_SQL,
} from '@/data/internals/treeQueries'
import { bench, type BenchResult } from './harness'
import { setupBenchEnv } from './setup'
import {
  populateBalanced,
  populateFanOut,
  populateLinearChain,
  populateRealistic,
} from './fixtures'

export const runReadBenches = async (): Promise<BenchResult[]> => {
  const out: BenchResult[] = []

  // ──── repo.load(id) cold (cache cleared between iters) ────
  {
    const env = await setupBenchEnv({instrumented: true})
    const tree = await populateBalanced(env.db, 4, 3)
    env.counters!.reset()
    const r = await bench('repo.load(id) cold', async () => {
      env.cache.deleteSnapshot(tree.rootId)
      await env.repo.load(tree.rootId)
    }, {warmup: 5})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1)}
    out.push(r)
    await env.cleanup()
  }

  // ──── repo.load(id, {children}) at varying width ────
  for (const width of [10, 100, 1000, 10000]) {
    const env = await setupBenchEnv({instrumented: true})
    const fan = await populateFanOut(env.db, width)
    env.counters!.reset()
    const r = await bench(`repo.load(id, {children}) (${width} children)`, async () => {
      // Wipe the cache so the load actually does work.
      for (const cid of fan.childIds) env.cache.deleteSnapshot(cid)
      env.cache.deleteSnapshot(fan.parentId)
      await env.repo.load(fan.parentId, {children: true})
    }, {warmup: 2, iters: 10})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1)}
    out.push(r)
    await env.cleanup()
  }

  // ──── repo.load(id, {ancestors}) at varying chain depth ────
  for (const depth of [10, 100, 1000]) {
    const env = await setupBenchEnv({instrumented: true})
    const chain = await populateLinearChain(env.db, depth)
    env.counters!.reset()
    const r = await bench(`repo.load(id, {ancestors}) (depth=${depth})`, async () => {
      for (const id of chain.ids) env.cache.deleteSnapshot(id)
      await env.repo.load(chain.leafId, {ancestors: true})
    }, {warmup: 2, iters: 10})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1)}
    out.push(r)
    await env.cleanup()
  }

  // ──── repo.load(id, {descendants}) at varying tree size ────
  for (const [bf, depth] of [[2, 5], [3, 5], [10, 3]]) {
    const env = await setupBenchEnv({instrumented: true})
    const tree = await populateBalanced(env.db, bf, depth)
    env.counters!.reset()
    const r = await bench(`repo.load(id, {descendants}) (n=${tree.totalNodes}, branching=${bf}, depth=${depth})`, async () => {
      for (const id of tree.ids) env.cache.deleteSnapshot(id)
      await env.repo.load(tree.rootId, {descendants: true})
    }, {warmup: 1, iters: 5})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1), n: tree.totalNodes}
    out.push(r)
    await env.cleanup()
  }

  // ──── Raw SUBTREE_SQL at varying tree size ────
  for (const [bf, depth] of [[5, 3], [10, 3], [10, 4]]) {
    const env = await setupBenchEnv()
    const tree = await populateBalanced(env.db, bf, depth)
    const r = await bench(`SUBTREE_SQL raw (n=${tree.totalNodes}, branching=${bf}, depth=${depth})`, async () => {
      await env.db.getAll(SUBTREE_SQL, [tree.rootId])
    }, {warmup: 2, maxIters: 200})
    r.metadata = {n: tree.totalNodes}
    out.push(r)
    await env.cleanup()
  }

  // ──── Raw ANCESTORS_SQL at varying chain depth ────
  for (const depth of [10, 100, 1000, 5000]) {
    const env = await setupBenchEnv()
    const chain = await populateLinearChain(env.db, depth)
    const r = await bench(`ANCESTORS_SQL raw (depth=${depth})`, async () => {
      await env.db.getAll(ANCESTORS_SQL, [chain.leafId, chain.leafId])
    }, {warmup: 2, maxIters: 100})
    r.metadata = {depth}
    out.push(r)
    await env.cleanup()
  }

  // ──── Raw IS_DESCENDANT_OF_SQL — yes/no answers in deep chain ────
  {
    const env = await setupBenchEnv()
    const chain = await populateLinearChain(env.db, 500)
    const r1 = await bench('IS_DESCENDANT_OF_SQL (yes, depth=500)', async () => {
      // chain.leafId IS a descendant of chain.rootId.
      await env.db.getAll(IS_DESCENDANT_OF_SQL, [chain.leafId, chain.rootId])
    }, {warmup: 2, maxIters: 200})
    r1.metadata = {answer: 'yes'}
    out.push(r1)
    const r2 = await bench('IS_DESCENDANT_OF_SQL (no, depth=500)', async () => {
      // root is not a descendant of leaf.
      await env.db.getAll(IS_DESCENDANT_OF_SQL, [chain.rootId, chain.leafId])
    }, {warmup: 2, maxIters: 200})
    r2.metadata = {answer: 'no'}
    out.push(r2)
    await env.cleanup()
  }

  // ──── Raw CHILDREN_SQL at varying width ────
  for (const width of [10, 1000, 10000]) {
    const env = await setupBenchEnv()
    const fan = await populateFanOut(env.db, width)
    const r = await bench(`CHILDREN_SQL raw (${width} children)`, async () => {
      await env.db.getAll(CHILDREN_SQL, [fan.parentId])
    }, {warmup: 2, maxIters: 100})
    r.metadata = {n: width}
    out.push(r)
    await env.cleanup()
  }

  // ──── repo.query.subtree({id}) handle: cold load + warm peek ────
  {
    const env = await setupBenchEnv({instrumented: true})
    const tree = await populateBalanced(env.db, 4, 4)  // 1+4+16+64+256 = 341
    env.counters!.reset()
    const r = await bench(`repo.query.subtree({id}) cold load (n=${tree.totalNodes})`, async () => {
      // Force fresh handle each time (otherwise we hit identity cache).
      env.repo.handleStore.clear()
      for (const id of tree.ids) env.cache.deleteSnapshot(id)
      await env.repo.query.subtree({id: tree.rootId}).load()
    }, {warmup: 1, iters: 5})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1), n: tree.totalNodes}
    out.push(r)

    // Warm peek path — same handle, same value, no IO.
    const handle = env.repo.query.subtree({id: tree.rootId})
    await handle.load()
    const r2 = await bench(`repo.query.subtree({id}).peek() warm (n=${tree.totalNodes})`, async () => {
      handle.peek()
    }, {warmup: 5, iters: 5000, totalTimeoutMs: 30_000})
    r2.metadata = {n: tree.totalNodes}
    out.push(r2)

    await env.cleanup()
  }

  // ──── §2 #7 verification: 1000 blocks × 5 levels = 1 SQL query ────
  {
    const env = await setupBenchEnv({instrumented: true})
    // Branching 4, depth 5 = 1 + 4 + 16 + 64 + 256 + 1024 = 1365 blocks
    // (close enough to "1000 blocks 5 levels deep" — we're verifying
    // the query count, not the row count).
    const tree = await populateBalanced(env.db, 4, 5)
    env.counters!.reset()
    await env.repo.query.subtree({id: tree.rootId}).load()
    const snap = env.counters!.snapshot()
    // Synthesize a result row purely to surface the count.
    out.push({
      name: `[§2 goal #7] subtree(n=${tree.totalNodes}, depth=5) — SQL query count`,
      iterations: 1, totalMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0,
      minMs: 0, maxMs: 0, stddevMs: 0, opsPerSec: 0,
      metadata: {
        getAll: snap.getAll,
        getOptional: snap.getOptional,
        get: snap.get,
        execute: snap.execute,
        wtx: snap.writeTransaction,
        total: snap.total,
        expected: '1 (one CTE call)',
        n: tree.totalNodes,
      },
    })
    await env.cleanup()
  }

  // ──── Cold-start "journal page" simulation ────
  // Open a deep page: load the page row + ancestors (breadcrumb) + the
  // full subtree (page contents). Count SQL roundtrips.
  {
    const env = await setupBenchEnv({instrumented: true})
    const ws = await populateRealistic(env.db, {pages: 5, bulletsPerPage: 10, subBulletsPerBullet: 4})
    const pageId = ws.pageIds[2]
    env.counters!.reset()
    const tStart = performance.now()
    await env.repo.load(pageId, {ancestors: true, descendants: true})
    await env.repo.query.subtree({id: pageId}).load()
    await env.repo.query.ancestors({id: pageId}).load()
    const elapsed = performance.now() - tStart
    const snap = env.counters!.snapshot()
    out.push({
      name: '[cold-start] open page (load+subtree+ancestors handles)',
      iterations: 1, totalMs: elapsed, meanMs: elapsed,
      p50Ms: elapsed, p95Ms: elapsed, p99Ms: elapsed,
      minMs: elapsed, maxMs: elapsed, stddevMs: 0, opsPerSec: 1000 / elapsed,
      metadata: {
        getAll: snap.getAll, getOptional: snap.getOptional,
        get: snap.get, total: snap.total,
        note: 'page+5 bullets×4 subs = 51 nodes',
      },
    })
    await env.cleanup()
  }

  return out
}
