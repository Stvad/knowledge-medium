/**
 * Navigation + first-load hot-path benchmarks — the "click up/down" canary.
 *
 * These model the two DB-touching UI paths the perf work targets:
 *
 *   1. First render of a page (cold): the outliner renders top-down via
 *      `useChildIds(block)` = `repo.query.childIds({id, hydrate:true})`,
 *      ONE query per expanded parent (each primes its child rows into the
 *      BlockCache). So opening a page with M expanded parents costs M SQL
 *      round-trips before first paint. `firstRenderCold` counts them.
 *
 *   2. Arrow up/down navigation: `nextVisibleBlock` / `previousVisibleBlock`
 *      walk the visible tree, doing `block.childIds.load()` per step. That
 *      getter uses the LEAN `childIds({id})` (hydrate:false) handle — a
 *      DIFFERENT handle key from the renderer's `hydrate:true` one — so it
 *      cannot reuse the render-warm cache and re-hits CHILDREN_IDS_SQL even
 *      when the renderer already holds the exact child-id list. We measure:
 *        - `navBurst`: a full traversal of a render-warm page (aggregate SQL).
 *        - `navColdPress`: a single press into a render-warm parent with the
 *          nav handle freshly GC'd — the crisp canary (1 SQL today → 0 if nav
 *          reuses the warm hydrate:true handle).
 *
 * The headline signal here is SQL ROUND-TRIP COUNT (via the instrumented db),
 * not wall-clock: the bench has no PowerSync sync-drain contention, so each
 * CHILDREN_IDS_SQL is sub-millisecond. In the real client those same queries
 * land behind the sync drain (p99 ~600ms in a big-DB profile, per block.ts),
 * so every round-trip removed here is a round-trip removed from that contended
 * path. Latency percentiles are reported too, but counts are the canary.
 */

import { nextVisibleBlock, previousVisibleBlock } from '@/utils/selection'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type { Unsubscribe } from '@/data/api'
import { bench, type BenchResult } from './harness'
import { setupBenchEnv, type BenchEnv } from './setup'
import { populateRealistic, seedReferences, type RealisticResult } from './fixtures'

/** Render-warm a page exactly as the outliner would: prime every row into
 *  the BlockCache (one descendants load) and create a subscribed,
 *  render-grade `childIds({id, hydrate:true})` handle for every block (the
 *  per-`BlockChildren` `useChildIds` subscription). Returns an unsubscribe
 *  that drops every subscription. */
const renderWarmPage = async (
  repo: Repo,
  ws: RealisticResult,
  pageId: string,
): Promise<Unsubscribe> => {
  // Prime all rows in one CTE (mirrors the cache state after a subtree load).
  await repo.load(pageId, {descendants: true})
  const subs: Unsubscribe[] = []
  // One subscribed hydrate:true child-id handle per block — this is the
  // warm state the renderer holds while the page is on screen.
  for (const id of ws.ids) {
    const h = repo.query.childIds({id, hydrate: true})
    subs.push(h.subscribe(() => {}))
    await h.load()
  }
  return () => { for (const u of subs) u() }
}

/** Walk the whole visible subtree under `scopeRootId` via `nextVisibleBlock`,
 *  returning the number of steps taken. Mirrors holding ArrowDown from the
 *  top of a page to the bottom. */
const walkDown = async (repo: Repo, scopeRootId: string): Promise<number> => {
  let current: Block | null = repo.block(scopeRootId)
  let steps = 0
  while (current) {
    const next: Block | null = await nextVisibleBlock(current, scopeRootId)
    if (!next) break
    current = next
    steps++
  }
  return steps
}

export const runNavBenches = async (opts: {full?: boolean} = {}): Promise<BenchResult[]> => {
  const out: BenchResult[] = []
  const full = opts.full ?? false

  // Page shape: one page (the scope root) with `bullets` children, each with
  // `subs` leaves. Fully expanded → every block is visible.
  const shapes = full
    ? [{bullets: 50, subs: 20}, {bullets: 100, subs: 30}]
    : [{bullets: 30, subs: 10}, {bullets: 60, subs: 15}]

  for (const shape of shapes) {
    const visible = 1 + shape.bullets + shape.bullets * shape.subs
    const parentsWithChildren = 1 + shape.bullets // page + each bullet
    const env: BenchEnv = await setupBenchEnv({instrumented: true})
    // 3 pages so backlinks have somewhere to point and the workspace isn't
    // trivially small; we navigate page index 1.
    const ws = await populateRealistic(env.db, {
      pages: 3,
      bulletsPerPage: shape.bullets,
      subBulletsPerBullet: shape.subs,
    })
    // Link density: every sub-bullet of the navigated page references 5 of
    // the page's bullets (so backlink-count handles have real work).
    const pageId = ws.pageIds[1]
    await seedReferences(env.db, {
      sourceIds: ws.ids.filter((_, i) => i % 3 === 0),
      targetIds: ws.pageIds,
      refsPerSource: 5,
    })

    const meta = {visible, parents: parentsWithChildren, bullets: shape.bullets, subs: shape.subs}

    // ──── 1. First render of the page (cold): M childIds(hydrate:true) ────
    // Clear caches + handles each iter so the load actually does SQL.
    {
      env.counters!.reset()
      const r = await bench(`firstRenderCold page (${visible} blocks, ${parentsWithChildren} parents)`, async () => {
        env.repo.handleStore.clear()
        for (const id of ws.ids) env.cache.deleteSnapshot(id)
        // Top-down render the renderer issues: one childIds(hydrate:true) per
        // parent-with-children — the page, then each of its bullets.
        const bulletIds = await env.repo.query.childIds({id: pageId, hydrate: true}).load()
        for (const bid of bulletIds) {
          await env.repo.query.childIds({id: bid, hydrate: true}).load()
        }
      }, {warmup: 1, iters: 5})
      const snap = env.counters!.snapshot()
      r.metadata = {...meta, sqlPerOpen: (snap.total / r.iterations).toFixed(1)}
      out.push(r)
    }

    // Render-warm the page for the navigation measurements.
    const unwarm = await renderWarmPage(env.repo, ws, pageId)

    // ──── 2. Nav burst: full ArrowDown traversal of the warm page ────
    {
      // Warm-up one full walk so any first-touch nav handles exist, then
      // measure: this is the "hold ArrowDown in a tight burst" regime.
      await walkDown(env.repo, pageId)
      env.counters!.reset()
      let steps = 0
      const r = await bench(`navBurst ArrowDown full page (${visible} blocks)`, async () => {
        steps = await walkDown(env.repo, pageId)
      }, {warmup: 0, iters: 5})
      const snap = env.counters!.snapshot()
      r.metadata = {
        ...meta,
        steps,
        sqlTotalPerWalk: (snap.total / r.iterations).toFixed(1),
        sqlPerPress: (snap.total / r.iterations / Math.max(1, steps)).toFixed(3),
      }
      out.push(r)
    }

    // ──── 3. Nav cold-press canary: one press into a render-warm region ────
    // The page is render-warm (hydrate:true subscribed). We press FROM a warm
    // block, disposing the lean hydrate:false handle each iter so every press
    // is a cold nav handle against an already-warm renderer handle — the
    // realistic "first arrow press after a >5s pause" regime. Covers BOTH
    // directions: ArrowDown (nextVisibleBlock) and ArrowUp (previousVisibleBlock).
    const bulletIds = await env.repo.query.childIds({id: pageId, hydrate: true}).load()
    {
      const warmParent = bulletIds[0] // has `subs` children, render-warm
      env.counters!.reset()
      let pressSql = 0
      const r = await bench(`navColdPress ArrowDown into render-warm parent`, async () => {
        const before = env.counters!.snapshot().total
        await nextVisibleBlock(env.repo.block(warmParent), pageId)
        pressSql = env.counters!.snapshot().total - before
        // Drop the lean nav handle so the next iter is a cold nav handle again
        // (mirrors the >5s GC gap between real arrow-key bursts).
        env.repo.query.childIds({id: warmParent}).dispose()
      }, {warmup: 2, iters: 30})
      r.metadata = {...meta, sqlPerColdPress: pressSql, note: 'parent is render-warm (hydrate:true subscribed)'}
      out.push(r)
    }
    {
      // ArrowUp from the 2nd sub of a warm bullet: previousVisibleBlock reads
      // the bullet's child list (line 90) to find the previous sibling, then
      // getLastVisibleDescendant on it — both must reuse the warm handle.
      const bulletId = bulletIds[0]
      const subs = await env.repo.query.childIds({id: bulletId, hydrate: true}).load()
      const from = subs[1] // has a previous sibling under a render-warm parent
      env.counters!.reset()
      let pressSql = 0
      const r = await bench(`navColdPress ArrowUp into render-warm parent`, async () => {
        const before = env.counters!.snapshot().total
        await previousVisibleBlock(env.repo.block(from), pageId)
        pressSql = env.counters!.snapshot().total - before
        env.repo.query.childIds({id: bulletId}).dispose()
      }, {warmup: 2, iters: 30})
      r.metadata = {...meta, sqlPerColdPress: pressSql, note: 'parent is render-warm (hydrate:true subscribed)'}
      out.push(r)
    }

    // ──── 4. focus write: the UI-state tx every arrow press commits ────
    {
      // A single setProperty-style UI-state tx, the focus write cost per press.
      const uiId = pageId // any row; we just measure the write+invalidation cost
      await env.repo.load(uiId)
      env.counters!.reset()
      let i = 0
      const r = await bench(`focusWrite ui-state tx (DB has ${ws.ids.length} rows)`, async () => {
        await env.repo.mutate['core.setContent']({id: uiId, content: `focus-${i++}`})
      }, {warmup: 3, iters: 30})
      const snap = env.counters!.snapshot()
      r.metadata = {...meta, sqlPerWrite: (snap.total / r.iterations).toFixed(1)}
      out.push(r)
      // restore content
      await env.repo.mutate['core.setContent']({id: uiId, content: `Page 1`})
    }

    unwarm()
    await env.cleanup()
  }

  return out
}
