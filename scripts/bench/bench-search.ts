/**
 * Search / scan kernel-query benchmarks.
 *
 *   - findBacklinks (the JSON1 EXISTS scan) at workspace size 1k/10k
 *     and reference-density 0/5/50.
 *   - searchBlocksByContent (LIKE substring).
 *   - findBlocksByType (json_extract on flat properties).
 *   - findAliasMatchesInWorkspace + getAliasesInWorkspace
 *     (alias is a JSON array of strings; uses json_each).
 *   - findFirstChildByContent (parent_id index + content equality).
 */

import { bench, type BenchResult } from './harness'
import { setupBenchEnv } from './setup'
import { populateFlat, seedProperty, seedReferences } from './fixtures'

export const runSearchBenches = async (): Promise<BenchResult[]> => {
  const out: BenchResult[] = []

  // ──── findBacklinks against workspaces of varying size + ref density ────
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
    const r = await bench(`findBacklinks (ws=${workspaceSize}, refs/block=${refsPer})`, async () => {
      await env.repo.findBacklinks(ws.workspaceId, target)
    }, {warmup: 2, maxIters: 50})
    r.metadata = {ws: workspaceSize, refsPer}
    out.push(r)
    await env.cleanup()
  }

  // ──── searchBlocksByContent at varying workspace size ────
  for (const ws of [1000, 10000]) {
    const env = await setupBenchEnv()
    const w = await populateFlat(env.db, ws)
    const r = await bench(`searchBlocksByContent ('flat-1', ws=${ws})`, async () => {
      // Query for 'flat-1' — matches 'flat-1', 'flat-10', 'flat-11' etc.
      await env.repo.searchBlocksByContent(w.workspaceId, 'flat-1', 50)
    }, {warmup: 2, maxIters: 50})
    r.metadata = {ws}
    out.push(r)
    await env.cleanup()
  }

  // ──── findBlocksByType — seed a `type` property on a fraction ────
  {
    const env = await setupBenchEnv()
    const w = await populateFlat(env.db, 10000)
    // Seed type on the first 1000 rows.
    const taggedIds = w.ids.slice(0, 1000)
    await seedProperty(env.db, {
      ids: taggedIds, key: 'type',
      valueFor: (_, i) => i % 3 === 0 ? 'note' : i % 3 === 1 ? 'task' : 'page',
    })
    const r = await bench(`findBlocksByType (ws=10k, 1000 tagged, type='note')`, async () => {
      await env.repo.findBlocksByType(w.workspaceId, 'note')
    }, {warmup: 2, maxIters: 50})
    out.push(r)
    await env.cleanup()
  }

  // ──── alias lookup + match (json_each on $.alias array) ────
  {
    const env = await setupBenchEnv()
    const w = await populateFlat(env.db, 10000)
    // Seed aliases on the first 500 rows. Each row gets an array with 2 aliases.
    const aliasIds = w.ids.slice(0, 500)
    await seedProperty(env.db, {
      ids: aliasIds, key: 'alias',
      valueFor: (_, i) => [`alpha-${i}`, `beta-${i}`],
    })

    const r1 = await bench(`findBlockByAliasInWorkspace ('alpha-100')`, async () => {
      await env.repo.findBlockByAliasInWorkspace(w.workspaceId, 'alpha-100')
    }, {warmup: 2, maxIters: 100})
    out.push(r1)

    const r2 = await bench(`findAliasMatchesInWorkspace ('alpha-')`, async () => {
      await env.repo.findAliasMatchesInWorkspace(w.workspaceId, 'alpha-', 50)
    }, {warmup: 2, maxIters: 50})
    out.push(r2)

    const r3 = await bench(`getAliasesInWorkspace (no filter, 1000 distinct)`, async () => {
      await env.repo.getAliasesInWorkspace(w.workspaceId, '')
    }, {warmup: 2, maxIters: 30})
    out.push(r3)

    await env.cleanup()
  }

  // ──── findFirstChildByContent ────
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
    const r = await bench('findFirstChildByContent (1000 sibs, content equality)', async () => {
      await env.repo.findFirstChildByContent(parentId, 'flat-500')
    }, {warmup: 2, maxIters: 200})
    out.push(r)
    await env.cleanup()
  }

  return out
}
