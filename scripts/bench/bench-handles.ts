/**
 * Handle store + reactivity benchmarks.
 *
 *   - Identity lookup hot path: 10k repo.children(id) calls — should be
 *     a Map.get with no walking.
 *   - HandleStore.invalidate fan-out vs registered handle count
 *     (1 / 100 / 1k / 10k handles, varying dep shapes). The walk is
 *     currently O(handles) — see reviewer note + spec §9.2.
 *   - LoaderHandle invalidate → re-resolve cycle latency.
 *   - BlockCache.setSnapshot notify cost with N subscribers.
 *   - **TX commit fan-out** (key reviewer concern): one repo.mutate.setContent
 *     end-to-end with M handles registered, varying dep shapes. The
 *     interesting question: does write latency degrade with more handles?
 *   - **Notification cascade per write** (key reviewer concern): one
 *     setContent on a deeply nested block — count subscribers fired
 *     (cache subs + handle subs) at each ancestor level. Data-layer
 *     proxy for "how many React subscribers wake up per keystroke."
 */

import type { ChangeNotification } from '@/data/internals/handleStore'
import { LoaderHandle, handleKey } from '@/data/internals/handleStore'
import { bench, type BenchResult } from './harness'
import { setupBenchEnv } from './setup'
import { populateBalanced, populateLinearChain } from './fixtures'

export const runHandleBenches = async (): Promise<BenchResult[]> => {
  const out: BenchResult[] = []

  // ──── Identity lookup hot path ────
  {
    const env = await setupBenchEnv()
    const tree = await populateBalanced(env.db, 4, 2)
    // Pre-create the handle so the hot path is purely Map.get.
    env.repo.query.children({id: tree.rootId})
    const r = await bench('repo.query.children({id}) identity hit (warm)', async () => {
      env.repo.query.children({id: tree.rootId})
    }, {warmup: 100, iters: 10000, totalTimeoutMs: 30_000})
    out.push(r)
    await env.cleanup()
  }

  // ──── HandleStore.invalidate fan-out vs registered count ────
  for (const N of [1, 100, 1000, 10000]) {
    const env = await setupBenchEnv()
    // Register N handles with mixed dep shapes (children/subtree/ancestors-style).
    // Use a fresh ids array — handles aren't loaded; we just install them
    // with synthetic deps via a one-shot loader.
    const ids = Array.from({length: N}, (_, i) => `h-${i}`)
    for (const id of ids) {
      const key = handleKey('synthetic', {id})
      env.repo.handleStore.getOrCreate(
        key,
        () => new LoaderHandle<string>({
          store: env.repo.handleStore, key,
          loader: async (ctx) => {
            ctx.depend({kind: 'row', id})
            ctx.depend({kind: 'parent-edge', parentId: id})
            return id
          },
        }),
      )
    }
    // Drive load on each so deps are populated. Without this, matches()
    // returns false (deps array empty).
    for (let i = 0; i < N; i++) {
      const key = handleKey('synthetic', {id: ids[i]})
      const h = env.repo.handleStore.getOrCreate<LoaderHandle<string>>(
        key,
        () => { throw new Error('expected to exist') },
      )
      await h.load()
    }
    // The notification touches one row; with N handles registered, only
    // 1 should match. Wall time covers the linear walk + the matched
    // handle's invalidate.
    const target = ids[Math.floor(N / 2)]
    const change: ChangeNotification = {rowIds: [target]}
    const r = await bench(`handleStore.invalidate (N=${N} registered, 1 match)`, async () => {
      env.repo.handleStore.invalidate(change)
    }, {warmup: 5, maxIters: 200})
    r.metadata = {N, matches: 1}
    out.push(r)
    await env.cleanup()
  }

  // ──── HandleStore.invalidate — many matches ────
  {
    const env = await setupBenchEnv()
    const N = 1000
    const ids = Array.from({length: N}, (_, i) => `h-${i}`)
    // All handles depend on the SAME workspace, so a workspace-scoped
    // invalidate matches every one.
    for (const id of ids) {
      const key = handleKey('synthetic-ws', {id})
      env.repo.handleStore.getOrCreate(
        key,
        () => new LoaderHandle<string>({
          store: env.repo.handleStore, key,
          loader: async (ctx) => {
            ctx.depend({kind: 'workspace', workspaceId: 'ws-shared'})
            return id
          },
        }),
      )
    }
    for (let i = 0; i < N; i++) {
      const key = handleKey('synthetic-ws', {id: ids[i]})
      const h = env.repo.handleStore.getOrCreate<LoaderHandle<string>>(
        key,
        () => { throw new Error('expected') },
      )
      await h.load()
    }
    const change: ChangeNotification = {workspaceIds: ['ws-shared']}
    const r = await bench(`handleStore.invalidate (N=${N} all match → re-resolve)`, async () => {
      env.repo.handleStore.invalidate(change)
    }, {warmup: 1, maxIters: 30})
    r.metadata = {N, matches: N}
    out.push(r)
    await env.cleanup()
  }

  // ──── LoaderHandle invalidate → re-resolve cycle (with real change) ────
  // We have to actually mutate the underlying data: re-resolving against
  // unchanged rows hits §9.4 structural-diff suppression and the
  // listener never fires. So the cycle is driven by `setContent` on a
  // child each iter — measures invalidate fan-out + re-load + diff +
  // notify. (This subsumes the pure-invalidate measurement; the
  // `handleStore.invalidate (N=…)` rows above already isolate the
  // synchronous walk cost.)
  {
    const env = await setupBenchEnv()
    const tree = await populateBalanced(env.db, 4, 2)
    // Hydrate the cache so the handle's children loader operates on
    // populated cache state (avoids cold-load noise per iter).
    await env.repo.load(tree.rootId, {children: true})
    const handle = env.repo.query.children({id: tree.rootId})
    await handle.load()
    let nextFire: (() => void) | null = null
    handle.subscribe(() => { nextFire?.(); nextFire = null })
    const childIds = tree.ids.filter(id => id !== tree.rootId).slice(0, 4)
    let counter = 0
    const r = await bench('LoaderHandle invalidate cycle (setContent on child → listener)', async () => {
      const fireSeen = new Promise<void>((resolve) => { nextFire = resolve })
      const childId = childIds[counter % childIds.length]
      counter++
      await env.repo.mutate['core.setContent']({id: childId, content: `c-${counter}`})
      await Promise.race([
        fireSeen,
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ])
    }, {warmup: 3, maxIters: 50, perIterTimeoutMs: 5_000, totalTimeoutMs: 30_000})
    out.push(r)
    await env.cleanup()
  }

  // ──── BlockCache.setSnapshot notify cost with N subscribers ────
  for (const subs of [1, 100, 1000]) {
    const env = await setupBenchEnv()
    const tree = await populateBalanced(env.db, 1, 0)
    const id = tree.rootId
    // populateBalanced writes raw SQL; cache is empty. Hydrate now so
    // setSnapshot below has a baseline shape to mutate.
    await env.repo.load(id)
    let fired = 0
    const dispose: Array<() => void> = []
    for (let i = 0; i < subs; i++) {
      dispose.push(env.cache.subscribe(id, () => { fired++ }))
    }
    let counter = 0
    const r = await bench(`BlockCache.setSnapshot notify (N=${subs} subs)`, async () => {
      counter++
      env.cache.setSnapshot({
        ...env.cache.requireSnapshot(id),
        content: `c-${counter}`,
        updatedAt: Date.now(),
      })
    }, {warmup: 5, maxIters: 300})
    r.metadata = {subs, totalFired: fired}
    out.push(r)
    for (const d of dispose) d()
    await env.cleanup()
  }

  // ──── BlockCache fingerprint dedup: identical snapshot → no notify ────
  {
    const env = await setupBenchEnv()
    const tree = await populateBalanced(env.db, 1, 0)
    const id = tree.rootId
    await env.repo.load(id)
    let fired = 0
    env.cache.subscribe(id, () => { fired++ })
    const snap = env.cache.requireSnapshot(id)
    const r = await bench('BlockCache.setSnapshot dedup (fingerprint match)', async () => {
      env.cache.setSnapshot(snap)
    }, {warmup: 5, maxIters: 5000})
    r.metadata = {fired, expectedFired: 0}
    out.push(r)
    await env.cleanup()
  }

  // ──── TX commit fan-out vs registered handle count ────
  for (const M of [0, 100, 1000, 10000]) {
    const env = await setupBenchEnv()
    const tree = await populateBalanced(env.db, 4, 3)
    const target = tree.leafIds[0]
    // Register M synthetic handles whose deps don't match `target` so
    // the invalidate walk visits them but doesn't re-resolve any.
    // Ids like `bystander-i` keep matches() at 0; the walk cost is what
    // we're measuring.
    for (let i = 0; i < M; i++) {
      const id = `bystander-${i}`
      const key = handleKey('synth-bystander', {id})
      const h = env.repo.handleStore.getOrCreate<LoaderHandle<string>>(
        key,
        () => new LoaderHandle<string>({
          store: env.repo.handleStore, key,
          loader: async (ctx) => {
            ctx.depend({kind: 'row', id})
            return id
          },
        }),
      )
      await h.load()
    }
    let i = 0
    const r = await bench(`mutate.setContent with ${M} bystander handles`, async () => {
      await env.repo.mutate['core.setContent']({id: target, content: `c-${i++}`})
    }, {warmup: 3, maxIters: 50})
    r.metadata = {bystanderHandles: M}
    out.push(r)
    await env.cleanup()
  }

  // ──── Notification cascade per write at varying tree depth ────
  // For a chain root → … → leaf, subscribe at every level via Block
  // facade (cache.subscribe) AND the relevant handle (`children` of
  // parent). Per iteration we capture a "next handle fire" Promise
  // (resolves on the first listener call after the write) and await
  // it with a per-iter timeout. End-to-end wall time covers tx commit
  // → cache notify → handle invalidate → re-resolve loader → listener.
  for (const depth of [1, 5, 25, 100]) {
    const env = await setupBenchEnv()
    const chain = await populateLinearChain(env.db, depth + 1)
    let cacheFired = 0
    let handleFired = 0
    let nextFire: (() => void) | null = null
    for (const id of chain.ids) env.cache.subscribe(id, () => { cacheFired++ })
    const ancH = env.repo.query.ancestors({id: chain.leafId})
    await ancH.load()
    ancH.subscribe(() => { handleFired++; nextFire?.(); nextFire = null })
    const parentId = chain.ids.length >= 2 ? chain.ids[chain.ids.length - 2] : chain.leafId
    const ch = env.repo.query.children({id: parentId})
    await ch.load()
    ch.subscribe(() => { handleFired++; nextFire?.(); nextFire = null })

    let counter = 0
    const r = await bench(`mutate.setContent leaf (chain depth=${depth}) — fan-out latency`, async () => {
      const fireSeen = new Promise<void>((resolve) => { nextFire = resolve })
      await env.repo.mutate['core.setContent']({id: chain.leafId, content: `c-${counter++}`})
      // Wait at most 1s for a handle listener to fire. Children handle
      // should re-resolve and notify once; ancestors handle for a
      // leaf doesn't fire (ANCESTORS_SQL excludes the start id, and
      // ancestor content didn't change). If neither fires, the timeout
      // catches it instead of a busy-wait.
      await Promise.race([
        fireSeen,
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ])
    }, {warmup: 2, maxIters: 20, perIterTimeoutMs: 5_000, totalTimeoutMs: 30_000})
    r.metadata = {
      depth,
      cacheNotifyPerWrite: (cacheFired / r.iterations).toFixed(1),
      handleFiresPerWrite: (handleFired / r.iterations).toFixed(1),
    }
    out.push(r)
    await env.cleanup()
  }

  return out
}
