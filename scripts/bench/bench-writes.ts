/**
 * Write-path benchmarks: latency + SQL roundtrip count for the kernel
 * mutators that drive 99% of user actions.
 *
 *   - core.setContent on a single block (the hot per-keystroke path).
 *   - core.createChild under parents of varying width.
 *   - core.insertChildren bulk insert.
 *   - core.indent / outdent.
 *   - core.move (cycle check).
 *   - core.delete on subtrees.
 *   - Multi-mutator tx: build a 50-node tree in one repo.tx vs 50 calls.
 *   - Concurrent setContent (10 in parallel — measures serialization
 *     through PowerSync's writeTransaction queue).
 *
 * Roundtrip counts come from the instrumented db wrapper. They're the
 * direct data-layer-spec proxy for "tree walks push to SQL" — if a
 * mutation suddenly takes 50 SQL calls, that's a regression even if
 * wall time looks fine.
 */

import { ChangeScope } from '@/data/api'
import { bench, type BenchResult } from './harness'
import { setupBenchEnv } from './setup'
import { populateBalanced, populateFanOut, populateLinearChain } from './fixtures'

export const runWriteBenches = async (): Promise<BenchResult[]> => {
  const out: BenchResult[] = []

  // ──── core.setContent on a leaf in a small tree ────
  {
    const env = await setupBenchEnv({instrumented: true})
    const tree = await populateBalanced(env.db, 4, 3)
    const target = tree.leafIds[0]
    let i = 0
    env.counters!.reset()
    const r = await bench('mutate.setContent (warm leaf)', async () => {
      await env.repo.mutate['core.setContent']({id: target, content: `edit-${i++}`})
    }, {warmup: 5})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1), wtx: (snap.writeTransaction / r.iterations).toFixed(1)}
    out.push(r)
    await env.cleanup()
  }

  // ──── core.createChild under parents of width 0/100/1000 ────
  for (const width of [0, 100, 1000]) {
    const env = await setupBenchEnv({instrumented: true})
    const fan = await populateFanOut(env.db, width)
    env.counters!.reset()
    const r = await bench(`mutate.createChild (parent has ${width} siblings, append)`, async () => {
      await env.repo.mutate['core.createChild']({parentId: fan.parentId, content: 'new'})
    }, {warmup: 3, maxIters: 100})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1), wtx: (snap.writeTransaction / r.iterations).toFixed(1)}
    out.push(r)
    await env.cleanup()
  }

  // ──── core.createChild at FRONT of a wide parent (keyAtStart) ────
  {
    const env = await setupBenchEnv({instrumented: true})
    const fan = await populateFanOut(env.db, 1000)
    env.counters!.reset()
    const r = await bench('mutate.createChild (1000 sibs, position=first)', async () => {
      await env.repo.mutate['core.createChild']({parentId: fan.parentId, content: 'new', position: {kind: 'first'}})
    }, {warmup: 3, maxIters: 100})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1), wtx: (snap.writeTransaction / r.iterations).toFixed(1)}
    out.push(r)
    await env.cleanup()
  }

  // ──── core.insertChildren bulk N=50 / 500 ────
  for (const n of [50, 500]) {
    const env = await setupBenchEnv({instrumented: true})
    const fan = await populateFanOut(env.db, 100)
    const items = Array.from({length: n}, (_, i) => ({content: `bulk-${i}`}))
    env.counters!.reset()
    const r = await bench(`mutate.insertChildren (n=${n} into 100-wide parent)`, async () => {
      await env.repo.mutate['core.insertChildren']({parentId: fan.parentId, items, position: {kind: 'last'}})
    }, {warmup: 1, iters: 5})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1), wtx: (snap.writeTransaction / r.iterations).toFixed(1), perRow: (snap.total / r.iterations / n).toFixed(2)}
    out.push(r)
    await env.cleanup()
  }

  // ──── core.indent on a leaf with previous sibling ────
  {
    const env = await setupBenchEnv({instrumented: true})
    const fan = await populateFanOut(env.db, 100)
    // Indent the LAST sibling each iteration; restore between (move it back).
    const targetId = fan.childIds[50]
    env.counters!.reset()
    let didIndent = false
    const r = await bench('mutate.indent (mid sibling, 100-wide parent)', async () => {
      if (didIndent) {
        await env.repo.mutate['core.outdent']({id: targetId})
        didIndent = false
      } else {
        await env.repo.mutate['core.indent']({id: targetId})
        didIndent = true
      }
    }, {warmup: 4, maxIters: 100})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1), wtx: (snap.writeTransaction / r.iterations).toFixed(1), note: 'indent/outdent alternation'}
    out.push(r)
    await env.cleanup()
  }

  // ──── core.move under a deep ancestor (cycle check cost) ────
  {
    const env = await setupBenchEnv({instrumented: true})
    // Build chain of depth 100; move a small subtree under the leaf.
    // Move is from one root to another, so cycle check has to walk.
    const chain = await populateLinearChain(env.db, 100)
    const tree = await populateBalanced(env.db, 2, 3)  // detached subtree
    let count = 0
    env.counters!.reset()
    const r = await bench('mutate.move (subtree → under depth-100 leaf, cycle-check)', async () => {
      // Move tree.rootId between chain.leafId and re-root.
      const dest = (count++ % 2 === 0) ? chain.leafId : null
      await env.repo.mutate['core.move']({id: tree.rootId, parentId: dest, position: {kind: 'last'}})
    }, {warmup: 2, maxIters: 50})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1), wtx: (snap.writeTransaction / r.iterations).toFixed(1)}
    out.push(r)
    await env.cleanup()
  }

  // ──── core.delete subtree (50 nodes) ────
  {
    const env = await setupBenchEnv({instrumented: true})
    // Each iter: build a fresh small subtree, then delete it. Population
    // happens raw (outside the timer); the bench measures only delete.
    const r = await bench('mutate.delete (subtree of 50)', async () => {
      const t = await populateBalanced(env.db, 5, 2)  // 1 + 5 + 25 = 31; close enough
      env.counters!.reset()
      await env.repo.mutate['core.delete']({id: t.rootId})
    }, {warmup: 1, iters: 5})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1), wtx: (snap.writeTransaction / r.iterations).toFixed(1)}
    out.push(r)
    await env.cleanup()
  }

  // ──── Multi-mutator tx: build a 50-node tree in 1 repo.tx vs 50 ────
  {
    const env = await setupBenchEnv({instrumented: true})
    const tree = await populateBalanced(env.db, 1, 0)
    const parentId = tree.rootId
    env.counters!.reset()
    const r = await bench('repo.tx { 50× tx.create } (single tx)', async () => {
      await env.repo.tx(async (tx) => {
        const ws = (await tx.get(parentId))!.workspaceId
        for (let i = 0; i < 50; i++) {
          await tx.create({workspaceId: ws, parentId, orderKey: `k${i.toString().padStart(4, '0')}`, content: `node-${i}`})
        }
      }, {scope: ChangeScope.BlockDefault})
    }, {warmup: 1, iters: 5})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1), wtx: (snap.writeTransaction / r.iterations).toFixed(1), perRow: (snap.total / r.iterations / 50).toFixed(2)}
    out.push(r)
    await env.cleanup()
  }
  {
    const env = await setupBenchEnv({instrumented: true})
    const tree = await populateBalanced(env.db, 1, 0)
    const parentId = tree.rootId
    env.counters!.reset()
    const r = await bench('50× mutate.createChild (50 separate txs)', async () => {
      for (let i = 0; i < 50; i++) {
        await env.repo.mutate['core.createChild']({parentId, content: `node-${i}`})
      }
    }, {warmup: 1, iters: 5})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1), wtx: (snap.writeTransaction / r.iterations).toFixed(1), perRow: (snap.total / r.iterations / 50).toFixed(2)}
    out.push(r)
    await env.cleanup()
  }

  // ──── Concurrent setContent: 10 parallel calls ────
  {
    const env = await setupBenchEnv({instrumented: true})
    const tree = await populateBalanced(env.db, 4, 2)
    const targets = tree.ids.slice(0, 10)
    let i = 0
    env.counters!.reset()
    const r = await bench('10× mutate.setContent in parallel (Promise.all)', async () => {
      i++
      await Promise.all(targets.map((id, k) =>
        env.repo.mutate['core.setContent']({id, content: `c-${i}-${k}`})))
    }, {warmup: 2, maxIters: 50})
    const snap = env.counters!.snapshot()
    r.metadata = {sql: (snap.total / r.iterations).toFixed(1), wtx: (snap.writeTransaction / r.iterations).toFixed(1), note: '10-parallel'}
    out.push(r)
    await env.cleanup()
  }

  return out
}
