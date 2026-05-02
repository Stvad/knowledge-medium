/**
 * Search / scan kernel-query benchmarks.
 *
 *   - backlinks (the JSON1 EXISTS scan) at workspace size 1k/10k
 *     and reference-density 0/5/50.
 *   - searchByContent (LIKE substring).
 *   - byType (json_extract on flat properties).
 *   - aliasMatches + aliasesInWorkspace (alias index, post-Phase 4 —
 *     reads from the dedicated `block_aliases` table, not json_each on
 *     properties_json).
 *   - aliasLookup (single-key alias index hit).
 *   - firstChildByContent (parent_id index + content equality).
 *
 * Post-Phase-4 note: every callsite goes through the typed
 * `repo.query.X({...})` dispatcher — legacy `repo.findX` factories were
 * removed in chunk C-2. Every `repo.query.X(...)` is an identity-stable
 * `LoaderHandle`; we call `.load()` to drive the resolver.
 */

import { bench, type BenchResult } from './harness'
import { setupBenchEnv } from './setup'
import { populateFlat, seedProperty, seedReferences } from './fixtures'

export const runSearchBenches = async (): Promise<BenchResult[]> => {
  const out: BenchResult[] = []

  // ──── backlinks against workspaces of varying size + ref density ────
  for (const [workspaceSize, refsPer] of [[1000, 5], [1000, 50], [10000, 5], [10000, 50]] as const) {
    const env = await setupBenchEnv()
    const ws = await populateFlat(env.db, workspaceSize)
    // Seed references: every block points at a few of its peers.
    await seedReferences(env.db, {
      sourceIds: ws.ids,
      targetIds: ws.ids,
      refsPerSource: refsPer,
    })
    // Pick a target with a known number of incoming refs (ws.ids[0]
    // tends to be referenced more often by the deterministic mod
    // pattern in seedReferences — that's fine, we just want a non-zero
    // result set).
    const target = ws.ids[0]
    // Force a fresh handle each iteration so we measure the resolver
    // (full SQL scan), not the warm peek from the handle store.
    const r = await bench(`repo.query.backlinks (ws=${workspaceSize}, refs/block=${refsPer})`, async () => {
      env.repo.handleStore.clear()
      await env.repo.query.backlinks({workspaceId: ws.workspaceId, id: target}).load()
    }, {warmup: 2, maxIters: 50})
    r.metadata = {ws: workspaceSize, refsPer}
    out.push(r)
    await env.cleanup()
  }

  // ──── searchByContent at varying workspace size ────
  for (const ws of [1000, 10000]) {
    const env = await setupBenchEnv()
    const w = await populateFlat(env.db, ws)
    const r = await bench(`repo.query.searchByContent ('flat-1', ws=${ws})`, async () => {
      // Query for 'flat-1' — matches 'flat-1', 'flat-10', 'flat-11' etc.
      env.repo.handleStore.clear()
      await env.repo.query.searchByContent({workspaceId: w.workspaceId, query: 'flat-1', limit: 50}).load()
    }, {warmup: 2, maxIters: 50})
    r.metadata = {ws}
    out.push(r)
    await env.cleanup()
  }

  // ──── byType — seed a `type` property on a fraction ────
  {
    const env = await setupBenchEnv()
    const w = await populateFlat(env.db, 10000)
    // Seed type on the first 1000 rows.
    const taggedIds = w.ids.slice(0, 1000)
    await seedProperty(env.db, {
      ids: taggedIds, key: 'type',
      valueFor: (_, i) => i % 3 === 0 ? 'note' : i % 3 === 1 ? 'task' : 'page',
    })
    const r = await bench(`repo.query.byType (ws=10k, 1000 tagged, type='note')`, async () => {
      env.repo.handleStore.clear()
      await env.repo.query.byType({workspaceId: w.workspaceId, type: 'note'}).load()
    }, {warmup: 2, maxIters: 50})
    out.push(r)
    await env.cleanup()
  }

  // ──── alias index queries ────
  // Post-Phase-4: aliases live in a dedicated `block_aliases` table that
  // triggers maintain on alias-property writes; query plans index-scan
  // a workspace+alias compound key instead of json_each on properties.
  {
    const env = await setupBenchEnv()
    const w = await populateFlat(env.db, 10000)
    // Seed aliases on the first 500 rows. Each row gets an array with 2
    // aliases; the trigger-driven backfill on alias property writes
    // populates block_aliases.
    const aliasIds = w.ids.slice(0, 500)
    await seedProperty(env.db, {
      ids: aliasIds, key: 'alias',
      valueFor: (_, i) => [`alpha-${i}`, `beta-${i}`],
    })

    const r1 = await bench(`repo.query.aliasLookup ('alpha-100')`, async () => {
      env.repo.handleStore.clear()
      await env.repo.query.aliasLookup({workspaceId: w.workspaceId, alias: 'alpha-100'}).load()
    }, {warmup: 2, maxIters: 200})
    out.push(r1)

    const r2 = await bench(`repo.query.aliasMatches ('alpha-')`, async () => {
      env.repo.handleStore.clear()
      await env.repo.query.aliasMatches({workspaceId: w.workspaceId, filter: 'alpha-', limit: 50}).load()
    }, {warmup: 2, maxIters: 100})
    out.push(r2)

    const r3 = await bench(`repo.query.aliasesInWorkspace (no filter, 1000 distinct)`, async () => {
      env.repo.handleStore.clear()
      await env.repo.query.aliasesInWorkspace({workspaceId: w.workspaceId, filter: ''}).load()
    }, {warmup: 2, maxIters: 50})
    out.push(r3)

    await env.cleanup()
  }

  // ──── firstChildByContent ────
  {
    const env = await setupBenchEnv()
    // Build one parent with 1000 children — content is unique per child.
    // Reuse populateFlat then update one row to be the parent.
    const w = await populateFlat(env.db, 1000)
    // Re-parent all under w.ids[0].
    const parentId = w.ids[0]
    await env.db.writeTransaction(async (tx) => {
      for (let i = 1; i < w.ids.length; i++) {
        await tx.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', [parentId, w.ids[i]])
      }
    })
    const r = await bench('repo.query.firstChildByContent (1000 sibs, content equality)', async () => {
      env.repo.handleStore.clear()
      await env.repo.query.firstChildByContent({parentId, content: 'flat-500'}).load()
    }, {warmup: 2, maxIters: 200})
    out.push(r)
    await env.cleanup()
  }

  // ──── Query dispatcher overhead: identity-hit hot path ────
  // After Phase 4 every kernel read goes through the dispatcher, which
  // does (1) a Map.get on the registry, (2) argsSchema.parse, (3) a
  // handleStore.getOrCreate keyed by JSON.stringify(args). We measure
  // the warm-handle path — repeated `repo.query.children({id})` calls
  // for the same id should be a hot Map.get. Args validation is paid
  // each call; quantifying it is the point.
  {
    const env = await setupBenchEnv()
    const w = await populateFlat(env.db, 10)
    const id = w.ids[0]
    // Prime the handle slot.
    env.repo.query.children({id})
    const r = await bench('repo.query.children({id}) dispatcher hit (warm)', async () => {
      env.repo.query.children({id})
    }, {warmup: 100, iters: 10000, totalTimeoutMs: 30_000})
    out.push(r)

    // Same surface, but each iter passes a fresh args object (different
    // identity, identical content) — the handle-key is the JSON
    // canonicalization, so identity should still hit. This pins the
    // canonicalization cost.
    const r2 = await bench('repo.query.children({id: ...fresh}) canonical-key hit', async () => {
      env.repo.query.children({id})
    }, {warmup: 100, iters: 10000, totalTimeoutMs: 30_000})
    out.push(r2)
    await env.cleanup()
  }

  return out
}
